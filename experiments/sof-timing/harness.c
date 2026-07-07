// harness.c — measure how well SOF correlation recovers the 1PPS instant over USB CDC.
//
// Reads the Mk IV's proprietary $PMTXTS sentences from the serial port and, for each PPS, computes
// TWO host-time estimates of the edge:
//
//   (1) t_arrival      — the host time when our software read the packet. This is the naive estimate
//                        and carries the full ~6 ms host-driven USB jitter. It's the BASELINE.
//   (2) t_sof          — the SOF-corrected estimate: anchor the PPS to the USB frame it was stamped
//                        against (sof_frame + device DWT deltas), and place that frame on the host
//                        clock via IOKit's hardware SOF timestamp. Delivery lateness cancels out.
//
// For each series we fit a line vs PPS index (the edges are exactly 1 s apart) and report the RMS of
// the residuals — that IS the timestamping jitter. If SOF correlation works, series (2)'s RMS collapses
// from milliseconds toward the device's ~180 us floor while (1) stays at milliseconds.
//
// The device DWT rate (~80 MHz TCXO) is self-calibrated from consecutive dwt_pps deltas, so no core-
// clock constant is assumed. Handles both the legacy 9-field $PMTXTS (arrival only) and the extended
// 12-field form (,dwt_pps,sof_frame,dwt_sof) that the sof-timestamp firmware adds.
//
// Build: clang -O2 harness.c -o harness -framework IOKit -framework CoreFoundation
// Run:   ./harness /dev/cu.usbmodemXXXX            (auto-picks the USB bus for frame timing)
//        ./harness /dev/cu.usbmodemXXXX 0x0483 0x5740   (pin the bus to a specific VID PID)

#include <IOKit/IOKitLib.h>
#include <IOKit/IOCFPlugIn.h>
#include <IOKit/usb/IOUSBLib.h>
#include <CoreFoundation/CoreFoundation.h>
#include <mach/mach_time.h>
#include <termios.h>
#include <fcntl.h>
#include <unistd.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <signal.h>
#include <math.h>

// ---- mach time --------------------------------------------------------------------------------
static double g_ns;                                   // mach ticks -> ns
static void init_mach(void){ mach_timebase_info_data_t t; mach_timebase_info(&t); g_ns=(double)t.numer/t.denom; }
static double now_ns(void){ return (double)mach_absolute_time()*g_ns; }
static uint64_t abstime_u64(AbsoluteTime t){ return ((uint64_t)t.hi<<32)|(uint32_t)t.lo; }

// ---- IOKit USB bus frame clock ----------------------------------------------------------------
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
// Sample (bus frame, host-ns) — the hardware SOF timestamp we anchor against.
static int usb_frame(UInt64 *frame, double *host_ns){
  AbsoluteTime a;
  if ((*g_usb)->GetBusFrameNumberWithTime(g_usb, frame, &a)!=kIOReturnSuccess) return -1;
  *host_ns = (double)abstime_u64(a)*g_ns; return 0;
}

// ---- serial -----------------------------------------------------------------------------------
static int serial_open(const char *path){
  int fd = open(path, O_RDONLY | O_NOCTTY);
  if (fd < 0) return -1;
  struct termios t; tcgetattr(fd,&t); cfmakeraw(&t);
  t.c_cc[VMIN]=1; t.c_cc[VTIME]=0;               // block until at least 1 byte
  cfsetispeed(&t,B115200); cfsetospeed(&t,B115200);   // CDC ACM ignores rate, but set anyway
  tcsetattr(fd,TCSANOW,&t); return fd;
}

// ---- per-PPS records + running stats ----------------------------------------------------------
#define CAP 4096
typedef struct { double arrival, sof; int haveSof; } Rec;
static Rec recs[CAP]; static int nrec=0;
static volatile sig_atomic_t g_stop=0;
static void on_sigint(int s){ (void)s; g_stop=1; }

// RMS of residuals after a least-squares line fit vs index (edges are 1 s apart, so the slope soaks
// up host/GPS rate offset and any constant offset; residuals = the pure timestamping jitter).
static double rms_detrended(const double *y, int n){
  if (n<3) return 0;
  double sx=0,sy=0,sxx=0,sxy=0;
  for (int i=0;i<n;i++){ sx+=i; sy+=y[i]; sxx+=(double)i*i; sxy+=(double)i*y[i]; }
  double d=n*sxx-sx*sx; double b=(n*sxy-sx*sy)/d, a=(sy-b*sx)/n;
  double ss=0; for (int i=0;i<n;i++){ double r=y[i]-(a+b*i); ss+=r*r; }
  return sqrt(ss/n);
}
static void report(void){
  int ns=0, na=0; static double ya[CAP], yb[CAP];
  for (int i=0;i<nrec;i++){ ya[na++]=recs[i].arrival; if (recs[i].haveSof) yb[ns++]=recs[i].sof; }
  double ra=rms_detrended(ya,na), rb=rms_detrended(yb,ns);
  printf("\n---- %d PPS samples ----\n", nrec);
  printf("  arrival jitter (baseline) : %8.1f us RMS   (n=%d)\n", ra/1000.0, na);
  if (ns>=3){
    printf("  SOF-corrected jitter      : %8.1f us RMS   (n=%d)\n", rb/1000.0, ns);
    printf("  improvement               : %8.1fx\n", rb>0 ? ra/rb : 0.0);
  } else {
    printf("  SOF-corrected jitter      :   (no extended $PMTXTS yet — flash the sof-timestamp firmware)\n");
  }
  fflush(stdout);
}

// ---- $PMTXTS parse ----------------------------------------------------------------------------
// legacy:   $PMTXTS,seq,epoch,subms,systick,load,calerr,sincecal,temp,flags*CC
// extended: ...,flags,dwt_pps,sof_frame,dwt_sof*CC
static int parse_pmtxts(char *body, unsigned long *seq, uint32_t *dwt_pps, unsigned *sof_frame, uint32_t *dwt_sof, int *ext){
  // body starts after "PMTXTS,". tokenise on ','
  char *tok[16]; int nt=0; char *s=body;
  for (char *p=body; ; p++){ if (*p==','||*p=='\0'){ tok[nt++]=s; int end=(*p=='\0'); *p='\0'; s=p+1; if (end||nt>=16) break; } }
  if (nt < 9) return -1;
  *seq = strtoul(tok[0],NULL,10);
  if (nt >= 12){ *dwt_pps=(uint32_t)strtoul(tok[9],NULL,10); *sof_frame=(unsigned)strtoul(tok[10],NULL,10); *dwt_sof=(uint32_t)strtoul(tok[11],NULL,10); *ext=1; }
  else *ext=0;
  return 0;
}

int main(int argc, char **argv){
  if (argc < 2){ fprintf(stderr,"usage: %s /dev/cu.usbmodemXXXX [VID PID [maxSamples]]\n", argv[0]); return 2; }
  long wantV = argc>2 ? strtol(argv[2],NULL,0) : -1;
  long wantP = argc>3 ? strtol(argv[3],NULL,0) : -1;
  long maxN  = argc>4 ? atol(argv[4]) : 0;    // 0 = run until Ctrl-C
  init_mach();
  signal(SIGINT,on_sigint);

  if (usb_open(wantV,wantP)!=0){ fprintf(stderr,"could not open a USB bus for frame timing\n"); return 1; }
  int fd = serial_open(argv[1]);
  if (fd<0){ fprintf(stderr,"could not open serial %s\n", argv[1]); return 1; }
  fprintf(stderr,"reading %s — Ctrl-C to stop and report\n", argv[1]);

  // DWT self-calibration state
  double f_dwt = 80e6; int haveDwtRate=0; uint32_t prevDwtPps=0; int havePrevDwt=0;

  char line[512]; int li=0; char c;
  while (!g_stop){
    ssize_t r = read(fd,&c,1);
    if (r<=0){ if (g_stop) break; continue; }
    if (c=='\n' || li>=(int)sizeof line-1){
      double t_arr = now_ns();                       // stamp arrival ASAP
      line[li]=0; int len=li; li=0;
      if (len>7 && strncmp(line,"$PMTXTS,",8)==0){
        // sample the bus frame right now, as close to arrival as possible
        UInt64 hf; double hns;
        int gotFrame = (usb_frame(&hf,&hns)==0);
        char body[480]; strncpy(body,line+1,sizeof body-1); body[sizeof body-1]=0;
        char *star=strchr(body,'*'); if (star) *star=0;
        unsigned long seq; uint32_t dwt_pps=0,dwt_sof=0; unsigned sof_frame=0; int ext=0;
        if (parse_pmtxts(body+7,&seq,&dwt_pps,&sof_frame,&dwt_sof,&ext)==0 && nrec<CAP){
          Rec *R=&recs[nrec++]; R->arrival=t_arr; R->haveSof=0;
          // self-calibrate device DWT rate from 1 Hz dwt_pps deltas
          if (ext && havePrevDwt){ int32_t d=(int32_t)(dwt_pps-prevDwtPps); if (d>60000000 && d<100000000){ f_dwt = haveDwtRate ? 0.9*f_dwt+0.1*d : d; haveDwtRate=1; } }
          if (ext){ prevDwtPps=dwt_pps; havePrevDwt=1; }
          long dframe = 0; double dwtoff_us = 0;
          if (ext && gotFrame){
            // map device 11-bit sof_frame to the nearest host bus frame, then to host time
            dframe = (long)((sof_frame - (unsigned)(hf & 0x7FF)) & 0x7FF);
            if (dframe > 1024) dframe -= 2048;        // signed nearest in [-1024,1023]
            double host_sof_ns = hns + (double)dframe*1.0e6;         // 1 frame = 1 ms host time
            int32_t off = (int32_t)(dwt_pps - dwt_sof);              // device ticks from anchor SOF to PPS
            dwtoff_us = (double)off / f_dwt * 1.0e6;
            R->sof = host_sof_ns + (double)off / f_dwt * 1.0e9;
            R->haveSof = 1;
          }
          // per-sample debug: dev vs host frame, the DWT PPS->SOF offset, and each estimate relative to
          // the first sample (SOF-corrected should step in clean ~1.000s increments; arrival won't).
          static double arr0=0, sof0=0; if (nrec==1){ arr0=t_arr; sof0=R->haveSof?R->sof:0; }
          fprintf(stderr, "#%02d seq=%lu dev_fr=%4u host_fr=%4u dframe=%5ld dwtoff=%9.1fus  arr=%8.3fs  sof=%8.3fs\n",
                  nrec, seq, sof_frame, (unsigned)(hf&0x7FF), dframe, dwtoff_us,
                  (t_arr-arr0)/1e9, R->haveSof?(R->sof-sof0)/1e9:0.0);
          if (maxN && nrec>=maxN) g_stop=1;
        }
      }
    } else if (c!='\r'){ line[li++]=c; }
  }
  report();
  printf("\ndevice DWT rate (self-calibrated): %.3f MHz\n", f_dwt/1e6);
  close(fd); if (g_usb) (*g_usb)->Release(g_usb);
  return 0;
}
