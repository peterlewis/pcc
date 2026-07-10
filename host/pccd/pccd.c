// pccd — the Precision Clock bridge daemon.  (macOS + Linux)
//
// Owns the Mk IV's serial port ONCE and fans it out, so the port is never fought over again:
//
//   [Mk IV] ── USB CDC ── pccd ──┬── chrony SOCK refclock   → disciplines this machine; chrony
//                                │                            then serves NTP to the whole LAN
//                                ├── WebSocket @ localhost  → the PCC web app connects here
//                                │                            (raw NMEA lines both ways; multiple tabs)
//                                └── HTTP GET /health       → daemon discovery for the app
//
// Time transfer, best available per platform:
//   macOS  — SOF correlation (see experiments/sof-timing/): the firmware latches its DWT cycle
//            counter at the PPS edge AND at a USB start-of-frame, and names that frame. IOKit's
//            GetBusFrameNumberWithTime places the same frame on the host clock in hardware, so
//            the PPS instant lands on the host clock immune to USB delivery jitter
//            (~100-175 us vs ~6 ms naive).             chrony precision 1e-4.
//   Linux  — no userspace API names a SOF frame, so the fallback stamps the $PMTXTS arrival
//            instead: the sentence is emitted within ~2 ms of the edge, so accuracy is limited
//            by USB CDC delivery (a few ms, slightly late-biased; trim with -o).
//                                                       chrony precision 1e-2.
//   The same fallback also covers macOS when the USB frame clock can't be opened.
//   offset(chrony) = (PPS true time = the $PMTXTS epoch second) - (host wall time of the edge).
//
// Build:  make            (clang/gcc; IOKit + CoreFoundation on macOS, no dependencies on Linux)
// Run:    ./pccd [-d /dev/...] [-p 4192] [-s /var/run/chrony.pcc.sock] [-o secs] [-n] [-v]
//           -d  serial device (default: first /dev/cu.usbmodem* on macOS,
//               /dev/serial/by-id/*STM32* then /dev/ttyACM* on Linux)
//           -p  HTTP/WebSocket port on 127.0.0.1 (default 4192)
//           -s  chrony SOCK path (default /var/run/chrony.pcc.sock; skipped if absent)
//           -o  fixed offset trim in seconds, added to every sample (arrival-mode latency, e.g. 0.003)
//           -n  dry run: print offsets, never write to chrony
//           -v  verbose per-sample logging
//           -t  self-test (SHA-1 / handshake vectors) and exit
//
// chrony.conf:   refclock SOCK /var/run/chrony.pcc.sock refid PCC precision 1e-4
// (run chronyd first so it creates the socket; pccd connects when it appears.)

#if !defined(__APPLE__) && !defined(_GNU_SOURCE)
#define _GNU_SOURCE                       /* strcasestr on glibc — must precede all includes */
#endif

#define PCCD_VERSION "0.1"

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

#ifdef __APPLE__
#include <IOKit/IOKitLib.h>
#include <IOKit/IOCFPlugIn.h>
#include <IOKit/usb/IOUSBLib.h>
#include <CoreFoundation/CoreFoundation.h>
#include <mach/mach_time.h>
#endif

// ---- options -----------------------------------------------------------------------------------
static const char *opt_dev  = NULL;
static int         opt_port = 4192;
static const char *opt_sock = "/var/run/chrony.pcc.sock";
static double      opt_trim = 0.0;
static int         opt_dry  = 0;
static int         opt_verb = 0;

// ---- monotonic time + wall mapping ---------------------------------------------------------------
// One monotonic nanosecond clock for retry timers, arrival stamps and (on macOS) the IOKit frame
// timestamps, which arrive in mach units and must share this timebase.
#ifdef __APPLE__
static double g_ns;                                     // mach ticks -> ns
static void   init_mono(void){ mach_timebase_info_data_t t; mach_timebase_info(&t); g_ns=(double)t.numer/t.denom; }
static double now_mono_ns(void){ return (double)mach_absolute_time()*g_ns; }
static uint64_t abstime_u64(AbsoluteTime t){ return ((uint64_t)t.hi<<32)|(uint32_t)t.lo; }
#else
static void   init_mono(void){}
static double now_mono_ns(void){ struct timespec ts; clock_gettime(CLOCK_MONOTONIC,&ts); return (double)ts.tv_sec*1e9+(double)ts.tv_nsec; }
#endif
// Wall-clock (CLOCK_REALTIME) time of a given monotonic-ns instant: bridge through a fresh sample
// pair. The pair is taken atomically enough (sub-us apart) that the mapping error is negligible here.
static double wall_of_mono_ns(double mono_ns){
  struct timespec ts; clock_gettime(CLOCK_REALTIME,&ts);
  double wall_now = (double)ts.tv_sec + (double)ts.tv_nsec*1e-9;
  return wall_now + (mono_ns - now_mono_ns())*1e-9;
}

// ---- USB bus frame clock --------------------------------------------------------------------------
// macOS: IOKit places a named SOF frame on the host clock in hardware (lifted from the proven
// harness). Linux: no userspace equivalent exists (usbfs has no frame-time ioctl) — stubs keep the
// call sites identical and the main loop falls back to arrival timestamping.
#ifdef __APPLE__
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
static int usb_frame(uint64_t *frame, double *host_mono_ns){
  AbsoluteTime a; UInt64 f;
  if (!g_usb || (*g_usb)->GetBusFrameNumberWithTime(g_usb,&f,&a)!=kIOReturnSuccess) return -1;
  *frame = (uint64_t)f;
  *host_mono_ns = (double)abstime_u64(a)*g_ns; return 0;
}
#else
static int  usb_open(long wantV, long wantP){ (void)wantV; (void)wantP; return -1; }
static void usb_close(void){}
static int  usb_frame(uint64_t *frame, double *host_mono_ns){ (void)frame; (void)host_mono_ns; return -1; }
#endif

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
// Default device: the Mk IV enumerates as CDC ACM.
#ifdef __APPLE__
static int serial_autopick(char *out, size_t n){
  DIR *d = opendir("/dev"); if (!d) return -1;
  struct dirent *e; int ok=-1;
  while ((e=readdir(d))){
    if (strncmp(e->d_name,"cu.usbmodem",11)==0){ snprintf(out,n,"/dev/%s",e->d_name); ok=0; break; }
  }
  closedir(d); return ok;
}
#else
static int serial_autopick(char *out, size_t n){
  // Prefer the stable by-id symlink for an STM32 CDC device, else the first ttyACM.
  DIR *d = opendir("/dev/serial/by-id");
  if (d){
    struct dirent *e;
    while ((e=readdir(d))){
      if (e->d_name[0]=='.') continue;
      if (strcasestr(e->d_name,"STM32")){ snprintf(out,n,"/dev/serial/by-id/%s",e->d_name); closedir(d); return 0; }
    }
    closedir(d);
  }
  d = opendir("/dev"); if (!d) return -1;
  struct dirent *e; int ok=-1;
  while ((e=readdir(d))){
    if (strncmp(e->d_name,"ttyACM",6)==0){ snprintf(out,n,"/dev/%s",e->d_name); ok=0; break; }
  }
  closedir(d); return ok;
}
#endif

// ---- chrony SOCK refclock client ------------------------------------------------------------------
// chrony's refclock SOCK datagram (refclock_sock.c). Compiled on the same platform as chronyd, so
// the struct layout matches the local chrony build.
struct sock_sample { struct timeval tv; double offset; int pulse; int leap; int _pad; int magic; };
#define SOCK_MAGIC 0x534f434b
static int g_chrony = -1;
static int g_chrony_warned = 0;
static void chrony_try_connect(void){
  if (g_chrony >= 0 || opt_dry) return;
  int fd = socket(AF_UNIX, SOCK_DGRAM, 0);
  if (fd < 0) return;
  struct sockaddr_un a; memset(&a,0,sizeof a); a.sun_family=AF_UNIX;
  snprintf(a.sun_path,sizeof a.sun_path,"%s",opt_sock);
  if (connect(fd,(struct sockaddr*)&a,sizeof a)==0){ g_chrony=fd; g_chrony_warned=0; fprintf(stderr,"[pccd] chrony SOCK connected: %s\n",opt_sock); }
  else {
    // chronyd creates the socket root-owned without the group/other write bit, so an unprivileged
    // pccd gets EACCES — a silent retry loop here cost a debugging session. Warn once PER OUTAGE
    // (chronyd restarts recreate the socket root-only, so this recurs; re-armed on every connect).
    if (errno==EACCES && !g_chrony_warned){
      g_chrony_warned = 1;
      fprintf(stderr,"[pccd] chrony socket %s exists but PERMISSION DENIED — run\n"
                     "[pccd]   sudo chmod 666 %s\n"
                     "[pccd] (after every chronyd restart), or run pccd itself as root.\n",opt_sock,opt_sock);
    }
    close(fd);
  }
}
static void chrony_send(double wall_of_pps, double offset){
  if (g_chrony < 0) return;
  struct sock_sample s; memset(&s,0,sizeof s);
  s.tv.tv_sec  = (time_t)wall_of_pps;
  s.tv.tv_usec = (suseconds_t)((wall_of_pps - (double)s.tv.tv_sec)*1e6);
  s.offset = offset;                                    // true - system
  s.pulse = 0; s.leap = 0; s.magic = SOCK_MAGIC;
  if (send(g_chrony,&s,sizeof s,0) < 0){
    fprintf(stderr,"[pccd] chrony SOCK send failed (%s) — feed lost, reconnecting (did chronyd restart?)\n",strerror(errno));
    close(g_chrony); g_chrony=-1;
  }
}

// ---- SHA-1 (for the RFC 6455 handshake only — NOT a general-purpose crypto hash) ------------------
// Self-contained so Linux needs no OpenSSL and macOS no CommonCrypto: one code path, both platforms.
// Verified against the RFC 3174 vectors and the RFC 6455 handshake vector by `pccd -t`.
static void sha1(const unsigned char *msg, size_t len, unsigned char out[20]){
  uint32_t h[5]={0x67452301,0xEFCDAB89,0x98BADCFE,0x10325476,0xC3D2E1F0};
  uint64_t bits=(uint64_t)len*8;
  size_t padded=((len+8)/64+1)*64;
  unsigned char blk[64];
  for (size_t base=0;base<padded;base+=64){
    for (int i=0;i<64;i++){
      size_t j=base+i;
      blk[i] = j<len ? msg[j] : (j==len ? 0x80 : (j>=padded-8 ? (unsigned char)(bits>>(8*(padded-1-j))) : 0));
    }
    uint32_t w[80];
    for (int i=0;i<16;i++) w[i]=((uint32_t)blk[4*i]<<24)|((uint32_t)blk[4*i+1]<<16)|((uint32_t)blk[4*i+2]<<8)|blk[4*i+3];
    for (int i=16;i<80;i++){ uint32_t x=w[i-3]^w[i-8]^w[i-14]^w[i-16]; w[i]=(x<<1)|(x>>31); }
    uint32_t a=h[0],b=h[1],c=h[2],d=h[3],e=h[4];
    for (int i=0;i<80;i++){
      uint32_t f,k;
      if (i<20){ f=(b&c)|((~b)&d); k=0x5A827999; }
      else if (i<40){ f=b^c^d; k=0x6ED9EBA1; }
      else if (i<60){ f=(b&c)|(b&d)|(c&d); k=0x8F1BBCDC; }
      else { f=b^c^d; k=0xCA62C1D6; }
      uint32_t t=((a<<5)|(a>>27))+f+e+k+w[i];
      e=d; d=c; c=(b<<30)|(b>>2); b=a; a=t;
    }
    h[0]+=a; h[1]+=b; h[2]+=c; h[3]+=d; h[4]+=e;
  }
  for (int i=0;i<5;i++){ out[4*i]=(unsigned char)(h[i]>>24); out[4*i+1]=(unsigned char)(h[i]>>16); out[4*i+2]=(unsigned char)(h[i]>>8); out[4*i+3]=(unsigned char)h[i]; }
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
static int self_test(void){
  static const struct { const char *msg; const char *hex; } V[] = {
    { "abc",            "a9993e364706816aba3e25717850c26c9cd0d89d" },   // RFC 3174
    { "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
                        "84983e441c3bd26ebaae4aa1f95129e5e54670f1" },   // RFC 3174
    { "",               "da39a3ee5e6b4b0d3255bfef95601890afd80709" },
  };
  int fail=0;
  for (size_t i=0;i<sizeof V/sizeof V[0];i++){
    unsigned char d[20]; char hex[41];
    sha1((const unsigned char*)V[i].msg,strlen(V[i].msg),d);
    for (int j=0;j<20;j++) snprintf(hex+2*j,3,"%02x",d[j]);
    if (strcmp(hex,V[i].hex)){ fprintf(stderr,"SHA1 FAIL '%s': %s != %s\n",V[i].msg,hex,V[i].hex); fail=1; }
  }
  // RFC 6455 §1.3 handshake vector
  const char *cat="dGhlIHNhbXBsZSBub25jZQ==258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
  unsigned char d[20]; char acc[64];
  sha1((const unsigned char*)cat,strlen(cat),d); b64(d,20,acc);
  if (strcmp(acc,"s3pPLMBiTxaQ9kYGzzhZRbK+xOo=")){ fprintf(stderr,"WS-accept FAIL: %s\n",acc); fail=1; }
  fprintf(stderr,"[pccd] self-test %s\n",fail?"FAILED":"OK");
  return fail;
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
    unsigned char sha[20];
    sha1((const unsigned char*)cat,strlen(cat),sha);
    char acc[64]; b64(sha,20,acc);
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
  char json[384];
  if (strstr(c->buf,"GET /health")){
    snprintf(json,sizeof json,"{\"pccd\":1,\"version\":\"" PCCD_VERSION "\",\"device\":\"%s\",\"chrony\":%s}",
             g_devpath, (g_chrony>=0)?"true":"false");
    body=json; type="application/json";
  } else { body="pccd: Precision Clock bridge. WebSocket here; GET /health for status.\n"; type="text/plain"; }
  char resp[768];
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
  char body[512]; snprintf(body,sizeof body,"%s",line+1);
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
    else if (!strcmp(argv[i],"-o") && i+1<argc) opt_trim=atof(argv[++i]);
    else if (!strcmp(argv[i],"-n")) opt_dry=1;
    else if (!strcmp(argv[i],"-v")) opt_verb=1;
    else if (!strcmp(argv[i],"-t")) return self_test();
    else { fprintf(stderr,"usage: pccd [-d dev] [-p port] [-s chrony.sock] [-o trim_s] [-n dry] [-v] [-t selftest]\n"); return 2; }
  }
  init_mono();
  signal(SIGINT,on_sig); signal(SIGTERM,on_sig); signal(SIGPIPE,SIG_IGN);
  for (int i=0;i<MAXCLI;i++) g_cli[i].fd=-1;

  g_listen = listen_open(opt_port);
  if (g_listen<0){ fprintf(stderr,"[pccd] cannot listen on 127.0.0.1:%d\n",opt_port); return 1; }
  fprintf(stderr,"[pccd] v" PCCD_VERSION " — http/ws on http://127.0.0.1:%d  (health: /health)%s\n",opt_port,opt_dry?"  [DRY RUN]":"");

  int sfd=-1; double next_retry=0;
  char line[512]; int li=0;
  double f_dwt=80e6; int haveRate=0; uint32_t prevDwt=0; int havePrev=0;
  long nsent=0, nseen=0;

  while (!g_stop){
    // (re)open serial + USB interface — the clock re-enumerates on config edits and firmware flashes,
    // so treat disconnection as routine and retry quietly.
    if (sfd<0 && now_mono_ns()>next_retry){
      const char *dev = opt_dev;
      if (!dev && serial_autopick(devbuf,sizeof devbuf)==0) dev=devbuf;
      if (dev && (sfd=serial_open(dev))>=0){
        usb_close(); usb_open(0x0483,-1);               // STM32 VID; frame clock rides the same bus
#ifdef __APPLE__
        fprintf(stderr,"[pccd] serial open: %s%s\n",dev,g_usb?"":"  (no USB frame clock — arrival timestamps, ~ms accuracy)");
#else
        fprintf(stderr,"[pccd] serial open: %s  (arrival timestamps — Linux has no USB frame clock; ~ms accuracy)\n",dev);
#endif
        havePrev=0; haveRate=0; li=0;
      } else next_retry = now_mono_ns()+2e9;
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
      double rx_mono = now_mono_ns();                    // arrival stamp for the frame-clock fallback
      char chunk[256];
      int r=(int)read(sfd,chunk,sizeof chunk);
      if (r<=0){ fprintf(stderr,"[pccd] serial lost — will retry\n"); close(sfd); sfd=-1; usb_close(); next_retry=now_mono_ns()+2e9; continue; }
      for (int i=0;i<r;i++){
        char ch=chunk[i];
        if (ch=='\n' || li>=(int)sizeof line-1){
          line[li]=0; int len=li; li=0;
          if (!len) continue;
          broadcast_line(line);                          // every line goes to every PCC tab
          if (len>8 && !strncmp(line,"$PMTXTS,",8)){
            uint64_t hf; double hmono; int gotF=(usb_frame(&hf,&hmono)==0);
            Pmtxts x;
            if (parse_pmtxts(line,&x)==0){
              nseen++;
              if (x.ext && havePrev){ int32_t d=(int32_t)(x.dwt_pps-prevDwt);
                if (d>60000000 && d<100000000){ f_dwt = haveRate ? 0.9*f_dwt+0.1*d : (double)d; haveRate=1; } }
              if (x.ext){ prevDwt=x.dwt_pps; havePrev=1; }
              if (x.flags==7){
                double pps_wall; const char *how;
                if (x.ext && gotF && haveRate){
                  // SOF path: place the named frame on the host clock, then step DWT ticks to the edge.
                  long dframe=(long)((x.sof_frame-(unsigned)(hf&0x7FF))&0x7FF);
                  if (dframe>1024) dframe-=2048;
                  double sof_mono = hmono + (double)dframe*1.0e6;             // 1 frame = 1 ms
                  double pps_mono = sof_mono + (double)(int32_t)(x.dwt_pps-x.dwt_sof)/f_dwt*1e9;
                  pps_wall = wall_of_mono_ns(pps_mono); how="sof";
                } else {
                  // Arrival path: the sentence lands a few ms after the edge it names.
                  pps_wall = wall_of_mono_ns(rx_mono); how="arr";
                }
                double offset = (double)x.epoch - pps_wall + opt_trim;        // true - system
                if (offset>-0.5 && offset<0.5){
                  if (!opt_dry) chrony_send(pps_wall,offset);
                  nsent++;
                  if (opt_verb || opt_dry)
                    fprintf(stderr,"[pccd] pps seq=%lu offset=%+11.6fs [%s] (host %s chrony)%s\n",
                            x.seq, offset, how, (g_chrony>=0&&!opt_dry)?"->":"-x",
                            opt_dry?"  [dry]":"");
                } else if (opt_verb)
                  fprintf(stderr,"[pccd] pps seq=%lu offset=%+.3fs [%s] REJECTED (sanity: check epoch/NTP)\n",x.seq,offset,how);
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
