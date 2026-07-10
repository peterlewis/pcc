// pccd — the Precision Clock bridge daemon.
//
// Owns the Mk IV's serial port ONCE and fans it out, so the port is never fought over again:
//
//   [Mk IV] ── USB CDC ── pccd ──┬── chrony SOCK refclock   → disciplines this Mac; chrony then
//                                │                            serves NTP to the whole LAN
//                                ├── WebSocket @ localhost  → the PCC web app connects here
//                                │                            (raw NMEA lines both ways; multiple tabs)
//                                └── HTTP GET /health       → daemon discovery for the app
//
// The time transfer is the proven SOF correlation (see experiments/sof-timing/): the firmware
// latches its DWT cycle counter at the PPS edge AND at a USB start-of-frame, and names that frame.
// IOKit's GetBusFrameNumberWithTime places the same frame on the host clock in hardware, so the
// PPS instant lands on the host clock immune to USB delivery jitter (~100-175 us vs ~6 ms naive).
// offset(chrony) = (PPS true time = the $PMTXTS epoch second) - (host wall time of the edge).
//
// Build:  make            (clang, IOKit + CoreFoundation, no other dependencies)
// Run:    ./pccd [-d /dev/cu.usbmodemXXXX] [-p 4192] [-s /var/run/chrony.pcc.sock] [-n] [-v]
//           -d  serial device (default: first /dev/cu.usbmodem*)
//           -p  HTTP/WebSocket port on 127.0.0.1 (default 4192)
//           -s  chrony SOCK path (default /var/run/chrony.pcc.sock; skipped if absent)
//           -n  dry run: print offsets, never write to chrony
//           -v  verbose per-sample logging
//
// chrony.conf:   refclock SOCK /var/run/chrony.pcc.sock refid PCC precision 1e-4
// (run chronyd first so it creates the socket; pccd connects when it appears.)

#include <IOKit/IOKitLib.h>
#include <IOKit/IOCFPlugIn.h>
#include <IOKit/usb/IOUSBLib.h>
#include <CoreFoundation/CoreFoundation.h>
#include <CommonCrypto/CommonDigest.h>
#include <mach/mach_time.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <arpa/inet.h>
#include <sys/time.h>
#include <termios.h>
#include <dirent.h>
#include <fcntl.h>
#include <unistd.h>
#include <poll.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <signal.h>
#include <stdint.h>
#include <time.h>

// ---- options -----------------------------------------------------------------------------------
static const char *opt_dev  = NULL;
static int         opt_port = 4192;
static const char *opt_sock = "/var/run/chrony.pcc.sock";
static int         opt_dry  = 0;
static int         opt_verb = 0;

// ---- mach time + wall mapping --------------------------------------------------------------------
static double g_ns;                                     // mach ticks -> ns
static void init_mach(void){ mach_timebase_info_data_t t; mach_timebase_info(&t); g_ns=(double)t.numer/t.denom; }
static double now_mach_ns(void){ return (double)mach_absolute_time()*g_ns; }
static uint64_t abstime_u64(AbsoluteTime t){ return ((uint64_t)t.hi<<32)|(uint32_t)t.lo; }
// Wall-clock (CLOCK_REALTIME) time of a given mach-ns instant: bridge through a fresh sample pair.
// The pair is taken atomically enough (sub-us apart) that the mapping error is negligible here.
static double wall_of_mach_ns(double mach_ns){
  struct timespec ts; clock_gettime(CLOCK_REALTIME,&ts);
  double wall_now = (double)ts.tv_sec + (double)ts.tv_nsec*1e-9;
  return wall_now + (mach_ns - now_mach_ns())*1e-9;
}

// ---- IOKit USB bus frame clock (lifted from the proven harness) ----------------------------------
static IOUSBDeviceInterface500 **g_usb = NULL;
static int usb_open(long wantV, long wantP){
  io_iterator_t it;
  if (IOServiceGetMatchingServices(kIOMainPortDefault, IOServiceMatching(kIOUSBDeviceClassName), &it)!=kIOReturnSuccess) return -1;
  io_service_t dev;
  while ((dev = IOIteratorNext(it))){
    UInt16 dv=0,dp=0; CFTypeRef v,p;
    if ((v=IORegistryEntryCreateCFProperty(dev,CFSTR("idVendor"), kCFAllocatorDefault,0))){ CFNumberGetValue(v,kCFNumberSInt16Type,&dv); CFRelease(v);}
    if ((p=IORegistryEntryCreateCFProperty(dev,CFSTR("idProduct"),kCFAllocatorDefault,0))){ CFNumberGetValue(p,kCFNumberSInt16Type,&dp); CFRelease(p);}
    if (wantV>=0 && (dv!=wantV || (wantP>=0 && dp!=wantP))){ IOObjectRelease(dev); continue; }
    IOCFPlugInInterface **pi=NULL; SInt32 sc;
    if (IOCreatePlugInInterfaceForService(dev,kIOUSBDeviceUserClientTypeID,kIOCFPlugInInterfaceID,&pi,&sc)==kIOReturnSuccess && pi){
      (*pi)->QueryInterface(pi, CFUUIDGetUUIDBytes(kIOUSBDeviceInterfaceID500),(LPVOID*)&g_usb);
      (*pi)->Release(pi);
    }
    if (g_usb){
      UInt64 f; AbsoluteTime a;
      if ((*g_usb)->GetBusFrameNumberWithTime(g_usb,&f,&a)==kIOReturnSuccess){ IOObjectRelease(dev); IOObjectRelease(it); return 0; }
      (*g_usb)->Release(g_usb); g_usb=NULL;
    }
    IOObjectRelease(dev);
  }
  IOObjectRelease(it); return -1;
}
static void usb_close(void){ if (g_usb){ (*g_usb)->Release(g_usb); g_usb=NULL; } }
static int usb_frame(UInt64 *frame, double *host_mach_ns){
  AbsoluteTime a;
  if (!g_usb || (*g_usb)->GetBusFrameNumberWithTime(g_usb, frame, &a)!=kIOReturnSuccess) return -1;
  *host_mach_ns = (double)abstime_u64(a)*g_ns; return 0;
}

// ---- serial (read-write: PCC commands flow back through us) --------------------------------------
static char g_devpath[256];
static int serial_open(const char *path){
  int fd = open(path, O_RDWR | O_NOCTTY | O_NONBLOCK);
  if (fd < 0) return -1;
  struct termios t; tcgetattr(fd,&t); cfmakeraw(&t);
  t.c_cc[VMIN]=0; t.c_cc[VTIME]=0;
  cfsetispeed(&t,B115200); cfsetospeed(&t,B115200);
  tcsetattr(fd,TCSANOW,&t);
  snprintf(g_devpath,sizeof g_devpath,"%s",path);
  return fd;
}
// Default device: the first /dev/cu.usbmodem* (the Mk IV enumerates as CDC ACM).
static int serial_autopick(char *out, size_t n){
  DIR *d = opendir("/dev"); if (!d) return -1;
  struct dirent *e; int ok=-1;
  while ((e=readdir(d))){
    if (strncmp(e->d_name,"cu.usbmodem",11)==0){ snprintf(out,n,"/dev/%s",e->d_name); ok=0; break; }
  }
  closedir(d); return ok;
}

// ---- chrony SOCK refclock client ------------------------------------------------------------------
// chrony's refclock SOCK datagram (refclock_sock.c). Compiled on the same platform as chronyd, so
// the struct layout matches the brew build.
struct sock_sample { struct timeval tv; double offset; int pulse; int leap; int _pad; int magic; };
#define SOCK_MAGIC 0x534f434b
static int g_chrony = -1;
static void chrony_try_connect(void){
  if (g_chrony >= 0 || opt_dry) return;
  int fd = socket(AF_UNIX, SOCK_DGRAM, 0);
  if (fd < 0) return;
  struct sockaddr_un a; memset(&a,0,sizeof a); a.sun_family=AF_UNIX;
  snprintf(a.sun_path,sizeof a.sun_path,"%s",opt_sock);
  if (connect(fd,(struct sockaddr*)&a,sizeof a)==0){ g_chrony=fd; fprintf(stderr,"[pccd] chrony SOCK connected: %s\n",opt_sock); }
  else close(fd);
}
static void chrony_send(double wall_of_pps, double offset){
  if (g_chrony < 0) return;
  struct sock_sample s; memset(&s,0,sizeof s);
  s.tv.tv_sec  = (time_t)wall_of_pps;
  s.tv.tv_usec = (suseconds_t)((wall_of_pps - (double)s.tv.tv_sec)*1e6);
  s.offset = offset;                                    // true - system
  s.pulse = 0; s.leap = 0; s.magic = SOCK_MAGIC;
  if (send(g_chrony,&s,sizeof s,0) < 0){ close(g_chrony); g_chrony=-1; }
}

// ---- WebSocket / HTTP server (RFC 6455, text frames, localhost only) ------------------------------
#define MAXCLI 8
typedef struct { int fd; int ws; char buf[2048]; int len; char lb[256]; int li; } Client;
static Client g_cli[MAXCLI];
static int g_listen = -1;

static void b64(const unsigned char *in, int n, char *out){
  static const char T[]="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  int i,o=0;
  for (i=0;i+2<n;i+=3){ out[o++]=T[in[i]>>2]; out[o++]=T[((in[i]&3)<<4)|(in[i+1]>>4)]; out[o++]=T[((in[i+1]&15)<<2)|(in[i+2]>>6)]; out[o++]=T[in[i+2]&63]; }
  if (i<n){ out[o++]=T[in[i]>>2];
    if (i+1<n){ out[o++]=T[((in[i]&3)<<4)|(in[i+1]>>4)]; out[o++]=T[(in[i+1]&15)<<2]; }
    else { out[o++]=T[(in[i]&3)<<4]; out[o++]='='; }
    out[o++]='='; }
  out[o]=0;
}
static void ws_send_text(Client *c, const char *msg, int n){
  if (!c->ws) return;
  unsigned char hdr[4]; int hl;
  if (n < 126){ hdr[0]=0x81; hdr[1]=(unsigned char)n; hl=2; }
  else { hdr[0]=0x81; hdr[1]=126; hdr[2]=(unsigned char)(n>>8); hdr[3]=(unsigned char)n; hl=4; }
  if (write(c->fd,hdr,hl)<0 || write(c->fd,msg,n)<0){ close(c->fd); c->fd=-1; }
}
static void broadcast_line(const char *line){
  char msg[600]; int n=snprintf(msg,sizeof msg,"%s",line); if (n<=0) return;
  for (int i=0;i<MAXCLI;i++) if (g_cli[i].fd>=0 && g_cli[i].ws) ws_send_text(&g_cli[i],msg,n);
}
static int listen_open(int port){
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  int one=1; setsockopt(fd,SOL_SOCKET,SO_REUSEADDR,&one,sizeof one);
  struct sockaddr_in a; memset(&a,0,sizeof a);
  a.sin_family=AF_INET; a.sin_port=htons((uint16_t)port);
  a.sin_addr.s_addr=htonl(INADDR_LOOPBACK);             // localhost ONLY — never exposed to the LAN
  if (bind(fd,(struct sockaddr*)&a,sizeof a)<0 || listen(fd,4)<0){ close(fd); return -1; }
  return fd;
}
// One HTTP request per plain connection: /health JSON (CORS-open so the deployed app can probe us),
// or a WebSocket upgrade. Anything else: a short status page.
static void http_or_upgrade(Client *c){
  c->buf[c->len]=0;
  if (!strstr(c->buf,"\r\n\r\n")) return;               // wait for full headers
  char *key = strcasestr(c->buf,"Sec-WebSocket-Key:");   // header names arrive in any case (undici: lowercase)
  if (key){
    key += 18; while (*key==' ') key++;
    char k[64]; int i=0; while (*key && *key!='\r' && i<40) k[i++]=*key++;
    k[i]=0;
    char cat[128]; snprintf(cat,sizeof cat,"%s258EAFA5-E914-47DA-95CA-C5AB0DC85B11",k);
    unsigned char sha[CC_SHA1_DIGEST_LENGTH];
    CC_SHA1(cat,(CC_LONG)strlen(cat),sha);
    char acc[64]; b64(sha,CC_SHA1_DIGEST_LENGTH,acc);
    char resp[256];
    int n=snprintf(resp,sizeof resp,
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
      "Sec-WebSocket-Accept: %s\r\n\r\n",acc);
    if (write(c->fd,resp,n)<0){ close(c->fd); c->fd=-1; return; }
    c->ws=1; c->len=0;
    char hello[300]; snprintf(hello,sizeof hello,"#PCCD v1 device=%s",g_devpath);
    ws_send_text(c,hello,(int)strlen(hello));
    fprintf(stderr,"[pccd] websocket client connected\n");
    return;
  }
  const char *body, *type;
  char json[256];
  if (strstr(c->buf,"GET /health")){
    snprintf(json,sizeof json,"{\"pccd\":1,\"device\":\"%s\",\"chrony\":%s}",
             g_devpath, (g_chrony>=0)?"true":"false");
    body=json; type="application/json";
  } else { body="pccd: Precision Clock bridge. WebSocket here; GET /health for status.\n"; type="text/plain"; }
  char resp[512];
  int n=snprintf(resp,sizeof resp,
    "HTTP/1.1 200 OK\r\nContent-Type: %s\r\nAccess-Control-Allow-Origin: *\r\n"
    "Content-Length: %zu\r\nConnection: close\r\n\r\n%s",type,strlen(body),body);
  write(c->fd,resp,n);
  close(c->fd); c->fd=-1;
}
// Unmask + deliver client->server text frames: each is a command line for the clock's serial port.
static void ws_read(Client *c, int serial_fd){
  unsigned char *b=(unsigned char*)c->buf;
  while (c->len >= 2){
    int op = b[0] & 0x0F, masked = b[1]&0x80, plen = b[1]&0x7F, off=2;
    if (plen==126){ if (c->len<4) return; plen=(b[2]<<8)|b[3]; off=4; }
    else if (plen==127){ close(c->fd); c->fd=-1; return; }      // no 64-bit frames here
    unsigned char *mask = b+off; if (masked) off+=4;
    if (c->len < off+plen) return;                              // partial frame — wait
    if (op==0x8){ close(c->fd); c->fd=-1; return; }             // close
    if (op==0x9){ b[0]=0x8A; write(c->fd,b,off+plen); }         // ping -> pong (echo payload)
    if (op==0x1 && serial_fd>=0){                               // text: a command line
      char cmd[300]; int n = plen<(int)sizeof cmd-2 ? plen : (int)sizeof cmd-2;
      for (int i=0;i<n;i++) cmd[i] = masked ? (char)(b[off+i]^mask[i&3]) : (char)b[off+i];
      cmd[n]=0;
      // strip any client newline, send with the firmware's expected CRLF
      while (n>0 && (cmd[n-1]=='\n'||cmd[n-1]=='\r')) cmd[--n]=0;
      if (n>0){ write(serial_fd,cmd,n); write(serial_fd,"\r\n",2); }
    }
    memmove(c->buf, c->buf+off+plen, c->len-(off+plen));
    c->len -= off+plen;
  }
}

// ---- $PMTXTS ------------------------------------------------------------------------------------
// $PMTXTS,seq,epoch,subms,systick,load,calerr,sincecal,temp,flags[,dwt_pps,sof_frame,dwt_sof]*CC
typedef struct { unsigned long seq, epoch; long flags; uint32_t dwt_pps,dwt_sof; unsigned sof_frame; int ext; } Pmtxts;
static int parse_pmtxts(const char *line, Pmtxts *o){
  char body[480]; snprintf(body,sizeof body,"%s",line+1);
  char *star=strchr(body,'*'); if (star) *star=0;
  char *tok[16]; int nt=0; char *s=body+7;              // after "PMTXTS,"
  for (char *p=s; ; p++){ if (*p==','||*p=='\0'){ tok[nt++]=s; int end=(*p=='\0'); *p='\0'; s=p+1; if (end||nt>=16) break; } }
  if (nt < 9) return -1;
  o->seq=strtoul(tok[0],NULL,10); o->epoch=strtoul(tok[1],NULL,10); o->flags=strtol(tok[8],NULL,16);
  if (nt >= 12){ o->dwt_pps=(uint32_t)strtoul(tok[9],NULL,10); o->sof_frame=(unsigned)strtoul(tok[10],NULL,10);
                 o->dwt_sof=(uint32_t)strtoul(tok[11],NULL,10); o->ext=1; }
  else o->ext=0;
  return 0;
}

static volatile sig_atomic_t g_stop=0;
static void on_sig(int s){ (void)s; g_stop=1; }

int main(int argc, char **argv){
  char devbuf[256]={0};
  for (int i=1;i<argc;i++){
    if (!strcmp(argv[i],"-d") && i+1<argc) opt_dev=argv[++i];
    else if (!strcmp(argv[i],"-p") && i+1<argc) opt_port=atoi(argv[++i]);
    else if (!strcmp(argv[i],"-s") && i+1<argc) opt_sock=argv[++i];
    else if (!strcmp(argv[i],"-n")) opt_dry=1;
    else if (!strcmp(argv[i],"-v")) opt_verb=1;
    else { fprintf(stderr,"usage: pccd [-d dev] [-p port] [-s chrony.sock] [-n dry] [-v]\n"); return 2; }
  }
  init_mach();
  signal(SIGINT,on_sig); signal(SIGTERM,on_sig); signal(SIGPIPE,SIG_IGN);
  for (int i=0;i<MAXCLI;i++) g_cli[i].fd=-1;

  g_listen = listen_open(opt_port);
  if (g_listen<0){ fprintf(stderr,"[pccd] cannot listen on 127.0.0.1:%d\n",opt_port); return 1; }
  fprintf(stderr,"[pccd] http/ws on http://127.0.0.1:%d  (health: /health)%s\n",opt_port,opt_dry?"  [DRY RUN]":"");

  int sfd=-1; double next_retry=0;
  char line[512]; int li=0;
  double f_dwt=80e6; int haveRate=0; uint32_t prevDwt=0; int havePrev=0;
  long nsent=0, nseen=0;

  while (!g_stop){
    // (re)open serial + USB interface — the clock re-enumerates on config edits and firmware flashes,
    // so treat disconnection as routine and retry quietly.
    if (sfd<0 && now_mach_ns()>next_retry){
      const char *dev = opt_dev;
      if (!dev && serial_autopick(devbuf,sizeof devbuf)==0) dev=devbuf;
      if (dev && (sfd=serial_open(dev))>=0){
        usb_close(); usb_open(0x0483,-1);               // STM32 VID; frame clock rides the same bus
        fprintf(stderr,"[pccd] serial open: %s%s\n",dev,g_usb?"":"  (no USB frame clock — arrival-only)");
        havePrev=0; haveRate=0; li=0;
      } else next_retry = now_mach_ns()+2e9;
    }
    chrony_try_connect();

    struct pollfd pf[2+MAXCLI]; int np=0, iSer=-1, iLis;
    if (sfd>=0){ pf[np].fd=sfd; pf[np].events=POLLIN; iSer=np++; }
    pf[np].fd=g_listen; pf[np].events=POLLIN; iLis=np++;
    int cmap[MAXCLI];
    for (int i=0;i<MAXCLI;i++) if (g_cli[i].fd>=0){ cmap[np-(iLis+1)]=i; pf[np].fd=g_cli[i].fd; pf[np].events=POLLIN; np++; }
    if (poll(pf,np,500)<0 && errno!=EINTR) break;

    // new connections
    if (pf[iLis].revents & POLLIN){
      int fd=accept(g_listen,NULL,NULL);
      if (fd>=0){
        int placed=0;
        for (int i=0;i<MAXCLI;i++) if (g_cli[i].fd<0){ memset(&g_cli[i],0,sizeof(Client)); g_cli[i].fd=fd; placed=1; break; }
        if (!placed) close(fd);
      }
    }
    // client traffic
    for (int p=iLis+1;p<np;p++){
      if (!(pf[p].revents & (POLLIN|POLLHUP|POLLERR))) continue;
      Client *c=&g_cli[cmap[p-(iLis+1)]];
      int r=(int)read(c->fd,c->buf+c->len,sizeof c->buf-1-c->len);
      if (r<=0){ close(c->fd); c->fd=-1; continue; }
      c->len+=r;
      if (c->ws) ws_read(c,sfd); else http_or_upgrade(c);
    }
    // serial
    if (iSer>=0 && (pf[iSer].revents & (POLLIN|POLLHUP|POLLERR))){
      char chunk[256];
      int r=(int)read(sfd,chunk,sizeof chunk);
      if (r<=0){ fprintf(stderr,"[pccd] serial lost — will retry\n"); close(sfd); sfd=-1; usb_close(); next_retry=now_mach_ns()+2e9; continue; }
      for (int i=0;i<r;i++){
        char ch=chunk[i];
        if (ch=='\n' || li>=(int)sizeof line-1){
          line[li]=0; int len=li; li=0;
          if (!len) continue;
          broadcast_line(line);                          // every line goes to every PCC tab
          if (len>8 && !strncmp(line,"$PMTXTS,",8)){
            UInt64 hf; double hmach; int gotF=(usb_frame(&hf,&hmach)==0);
            Pmtxts x;
            if (parse_pmtxts(line,&x)==0){
              nseen++;
              if (x.ext && havePrev){ int32_t d=(int32_t)(x.dwt_pps-prevDwt);
                if (d>60000000 && d<100000000){ f_dwt = haveRate ? 0.9*f_dwt+0.1*d : (double)d; haveRate=1; } }
              if (x.ext){ prevDwt=x.dwt_pps; havePrev=1; }
              if (x.ext && gotF && haveRate && x.flags==7){
                long dframe=(long)((x.sof_frame-(unsigned)(hf&0x7FF))&0x7FF);
                if (dframe>1024) dframe-=2048;
                double sof_mach = hmach + (double)dframe*1.0e6;             // 1 frame = 1 ms
                double pps_mach = sof_mach + (double)(int32_t)(x.dwt_pps-x.dwt_sof)/f_dwt*1e9;
                double pps_wall = wall_of_mach_ns(pps_mach);
                double offset   = (double)x.epoch - pps_wall;               // true - system
                if (offset>-0.5 && offset<0.5){
                  if (!opt_dry) chrony_send(pps_wall,offset);
                  nsent++;
                  if (opt_verb || opt_dry)
                    fprintf(stderr,"[pccd] pps seq=%lu offset=%+11.6fs (host %s chrony)%s\n",
                            x.seq, offset, (g_chrony>=0&&!opt_dry)?"->":"-x",
                            opt_dry?"  [dry]":"");
                } else if (opt_verb)
                  fprintf(stderr,"[pccd] pps seq=%lu offset=%+.3fs REJECTED (sanity: check epoch/NTP)\n",x.seq,offset);
              }
            }
          }
        } else if (ch!='\r'){ line[li++]=ch; }
      }
    }
  }
  fprintf(stderr,"[pccd] exiting — %ld PPS samples processed, %ld usable\n",nseen,nsent);
  if (sfd>=0) close(sfd);
  usb_close();
  if (g_chrony>=0) close(g_chrony);
  if (g_listen>=0) close(g_listen);
  return 0;
}
