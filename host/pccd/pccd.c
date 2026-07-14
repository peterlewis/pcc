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
//   Linux  — no userspace API names a SOF frame, so pccd reconstructs the anchor by SOF-clock
//            REGRESSION: the device SOF counter is locked to the host 1 ms frame clock, so
//            regressing arrival-time vs frame-number (both in $PMTXTS) recovers host-time-of-frame
//            and the delivery jitter averages out. Logs [reg] warm, [arr] cold. A constant
//            delivery bias remains (trim with -o).      chrony precision 1e-2 (improving).
//   The same fallback also covers macOS when the USB frame clock can't be opened.
//   offset(chrony) = (PPS true time = the $PMTXTS epoch second) - (host wall time of the edge).
//
// Build:  make            (clang/gcc; IOKit + CoreFoundation on macOS, no dependencies on Linux)
// Run:    ./pccd [-d /dev/...] [-p 4192] [-s /var/run/chrony.pcc.sock] [-o secs] [-n] [-v]
//           -d  serial device (default: first /dev/cu.usbmodem* on macOS,
//               /dev/serial/by-id/*STM32* then /dev/ttyACM* on Linux)
//           -p  HTTP/WebSocket port on 127.0.0.1 (default 4192)
//           -s  chrony SOCK path (default /var/run/chrony.pcc.sock; skipped if absent)
//           -w  serve the PCC web app from this dir at http://localhost:<port> (same-origin bridge;
//               fixes Safari/strict-browser mixed-content block against the deployed https:// site)
//           -o  fixed offset trim in seconds, added to every sample (arrival-mode latency, e.g. 0.003)
//           -n  dry run: print offsets, never write to chrony
//           -v  verbose per-sample logging
//           -r  raw: bypass the sample prefilter (outlier gate + trimmed-mean aggregation)
//           -t  self-test (SHA-1 / handshake / prefilter vectors) and exit
//           -T  frame probe: burst-read the USB frame clock and report bracket widths (macOS)
//           -h  print usage and exit
//
// chrony.conf:   refclock SOCK /var/run/chrony.pcc.sock refid PCC precision 1e-4
// (run chronyd first so it creates the socket; pccd connects when it appears.)

#if !defined(__APPLE__) && !defined(_GNU_SOURCE)
#define _GNU_SOURCE                       /* strcasestr on glibc — must precede all includes */
#endif

#ifndef PCCD_VERSION
#define PCCD_VERSION "0.4"                 /* overridable (-DPCCD_VERSION=...) so a test build can look older */
#endif
#ifdef PCCD_GIT
#define PCCD_VERSTR PCCD_VERSION "+" PCCD_GIT      /* Makefile stamps the short git hash for traceable /health */
#else
#define PCCD_VERSTR PCCD_VERSION
#endif

#include <sys/socket.h>
#include <sys/un.h>
#include <sys/stat.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <arpa/inet.h>
#include <sys/time.h>
#include <termios.h>
#include <dirent.h>
#include <fcntl.h>
#include <sys/ioctl.h>
#include <unistd.h>
#include <poll.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <signal.h>
#include <stdint.h>
#include <math.h>
#include <time.h>
#ifdef __APPLE__
#include <mach-o/dyld.h>                   /* _NSGetExecutablePath — locate a co-located bundled app */
#endif

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
static int         opt_raw  = 0;
static const char *opt_webroot = NULL;   // -w: serve the PCC app from this dir (same-origin, no mixed content)
static int         opt_webroot_flag = 0; // was -w given? (an explicit webroot means a dev build — no self-update)

// ---- self-update ---------------------------------------------------------------------------------
// A running tarball install can pull a newer release over itself. g_platform is the release-asset tag
// (baked by dist.sh/CI: "macos-universal" / "linux-x86_64" / "linux-aarch64"); a plain `make` build
// leaves it NULL so self-update stays off. g_updatable is only set when we're a bundled tarball (not -w).
#ifdef PCCD_PLATFORM
static const char *g_platform = PCCD_PLATFORM;
#else
static const char *g_platform = NULL;
#endif
static int    g_updatable = 0;           // set in main(): platform known AND running a bundled tarball
static char **g_argv = NULL;             // saved argv for an execv() relaunch after a standalone update

// ---- the $PMTXTS stream is OURS to switch on -------------------------------------------------------
// chrony gets nothing unless the clock is emitting $PMTXTS, and the firmware only does that when
// `pps = on`. The config default is `pps = off`, so a freshly-booted clock streams NOTHING — and a
// browser app that politely sends `pps = off` when it disconnects would silently kill our chrony feed
// (it did: a closed tab cost 7 h of stratum-1). We own the port, so we own the switch: assert it on
// every serial open, and re-assert if the stream ever goes quiet while the port is up.
static double g_last_ppson = 0;          // when we last wrote `pps = on` (monotonic ns); pps_assert() below

// ---- daemon liveness / health state (file-scope so the /health handler can read it) --------------
static long   g_nseen=0, g_nsent=0;   // $PMTXTS parsed / usable samples (promoted from main for /health)
static double g_last_sample_mono=0;   // now_mono_ns() of the last accepted PPS sample (0 = none yet)
static double g_last_offset=0;        // last accepted offset, seconds (true - system)
static int    g_serial_open=0;        // is the serial fd currently open?
static int    g_nodev_warned=0;       // "no clock found" printed once per outage (mirrors g_chrony_warned)

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
// Read the bus frame clock as (frame number, host mono-ns of that frame's start).
//
// Preferred path — microframe EDGE-HUNT: IOUSBDeviceInterface500 exposes GetBusMicroFrameNumber
// (the xHCI MFINDEX 125 us counter paired with a time-of-read, NOT a hardware anchor). Spin-read
// until the counter increments: the transition pins a microframe boundary to the host clock to
// within the bracketed width of ONE call (a few us), an 8x finer and self-validating anchor than
// GetBusFrameNumberWithTime's driver-supplied SOF pairing. Reads bracketed with mach timestamps;
// a wide bracket means preemption mid-call, so hunt again and keep the tightest edge.
// Fallback — GetBusFrameNumberWithTime (the proven +/-70 us harness path) when microframes are
// unavailable or the hunt keeps getting preempted.
static int g_no_micro = 0;
static int usb_frame(uint64_t *frame, double *host_mono_ns){
  if (!g_usb) return -1;
  if (!g_no_micro){
    double best_w=1e18, best_t=0; uint64_t best_m=0; int have=0;
    for (int hunt=0; hunt<3 && !have; hunt++){
      UInt64 m0; AbsoluteTime a;
      if ((*g_usb)->GetBusMicroFrameNumber(g_usb,&m0,&a)!=kIOReturnSuccess){
        g_no_micro=1; fprintf(stderr,"[pccd] no microframe clock — using 1 ms frame API\n"); break;
      }
      // spin across one 125 us boundary (<=200 us worst case per hunt)
      for (int i=0;i<400;i++){
        UInt64 m; double t0=now_mono_ns();
        if ((*g_usb)->GetBusMicroFrameNumber(g_usb,&m,&a)!=kIOReturnSuccess){ g_no_micro=1; break; }
        double t1=now_mono_ns();
        if (m!=m0){                                        // the boundary fell inside THIS call
          double w=t1-t0;
          if (w<best_w){ best_w=w; best_m=(uint64_t)m; best_t=0.5*(t0+t1); }
          if (w<20e3) have=1;                              // <20 us bracket: clean edge, done
          break;
        }
      }
      if (best_w<1e18) have = have || hunt==2;             // after 3 hunts take the tightest seen
    }
    if (!g_no_micro && best_w<1e18){
      // best_m just STARTED at best_t (+/- best_w/2). Anchor at the containing frame's start so
      // the dframe math downstream is unchanged.
      *frame = best_m>>3;
      *host_mono_ns = best_t - (double)(best_m&7)*125e3;
      return 0;
    }
    if (!g_no_micro) return -1;
  }
  AbsoluteTime a; UInt64 f;
  if ((*g_usb)->GetBusFrameNumberWithTime(g_usb,&f,&a)!=kIOReturnSuccess) return -1;
  *frame = (uint64_t)f;
  *host_mono_ns = (double)abstime_u64(a)*g_ns;
  return 0;
}
// -T: open the clock's USB device and print a burst of frame-clock reads with bracket widths —
// a hardware sanity check for the microframe path without touching the serial port (safe to run
// while the daemon owns the tty).
static int frame_probe(void){
  init_mono();
  if (usb_open(0x0483,-1)!=0){ fprintf(stderr,"[pccd] frame probe: no STM32 USB device found\n"); return 1; }
  fprintf(stderr,"[pccd] frame probe — microframe edge-hunt vs GetBusFrameNumberWithTime:\n");
  fprintf(stderr,"  (delta = edge-hunt anchor minus WithTime anchor for the same frame timeline;\n"
                 "   a stable delta means both clocks agree, its scatter shows which is cleaner)\n");
  for (int i=0;i<8;i++){
    uint64_t fm; double tm;
    int mok = usb_frame(&fm,&tm)==0 && !g_no_micro;
    UInt64 fw; AbsoluteTime a;
    int wok = (*g_usb)->GetBusFrameNumberWithTime(g_usb,&fw,&a)==kIOReturnSuccess;
    if (!mok || !wok){
      fprintf(stderr,"  micro=%s withtime=%s\n", mok?"ok":"FAIL", wok?"ok":"FAIL");
      if (!wok){ usb_close(); return 1; }
    } else {
      double tw=(double)abstime_u64(a)*g_ns;
      // both anchors name a frame start on the same mono clock: project WithTime's anchor onto
      // the edge-hunted frame and difference them.
      double delta_us = (tm - (tw + (double)((int64_t)(fm-(uint64_t)fw))*1e6))*1e-3;
      fprintf(stderr,"  frame=%8llu  edge-hunt=%.6fs  withtime(frame %llu)=%.6fs  delta=%+8.1fus\n",
              (unsigned long long)fm, tm*1e-9, (unsigned long long)fw, tw*1e-9, delta_us);
    }
    struct timespec ts={0,250*1000*1000}; nanosleep(&ts,NULL);   // 250 ms between reads
  }
  usb_close();
  fprintf(stderr,"[pccd] frame probe done (%s)\n", g_no_micro?"frame API — microframes unavailable":"microframe edge-hunt active");
  return 0;
}
#else
static int  usb_open(long wantV, long wantP){ (void)wantV; (void)wantP; return -1; }
static void usb_close(void){}
static int  usb_frame(uint64_t *frame, double *host_mono_ns){ (void)frame; (void)host_mono_ns; return -1; }
static int  frame_probe(void){ fprintf(stderr,"[pccd] frame probe: no USB frame clock on this platform (macOS only)\n"); return 1; }
#endif

// ---- serial (read-write: PCC commands flow back through us) --------------------------------------
static char g_devpath[512];   // matches devbuf; /dev/serial/by-id/ paths can be long
static int serial_open(const char *path){
  int fd = open(path, O_RDWR | O_NOCTTY | O_NONBLOCK | O_CLOEXEC);   // CLOEXEC: don't leak the tty to curl/tar, or to an execv relaunch
  if (fd < 0) return -1;
  // Exclusive: once we own the port, a second pccd's open() fails instead of both reading the same
  // stream and splitting the bytes (which silently corrupts both). Advisory, but every pccd sets it.
  if (ioctl(fd, TIOCEXCL) != 0) { /* not a tty (e.g. test path) — harmless */ }
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

// Assert `pps = on` on the clock's serial port. See g_last_ppson above: the firmware only emits the
// $PMTXTS we feed chrony with when this is on, the config default is off, and any app that sends
// `pps = off` on disconnect would otherwise silently end our stratum-1 feed. Idempotent + cheap.
static void pps_assert(int sfd){
  if (sfd < 0) return;
  static const char cmd[] = "pps = on\r\n";
  ssize_t w = write(sfd, cmd, sizeof cmd - 1); (void)w;
  g_last_ppson = now_mono_ns();
}

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
  fcntl(fd, F_SETFD, FD_CLOEXEC);
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

// ---- SOF-clock regression (Linux [sof]-class path; validated against IOKit on macOS) --------------
// The firmware names, for each PPS, the USB SOF frame nearest the edge and the DWT cycle offset from
// that SOF to the edge. macOS learns that frame's host time from IOKit; Linux has no such API — but
// the device's SOF counter is driven by the host's 1 ms SOF packets, so it is locked to the host
// clock. Regressing sentence-arrival-time against the (unwrapped) frame number over a sliding window
// recovers the host frame period (slope) and phase (intercept), giving host-time-of-frame for any
// frame; the random USB delivery jitter averages out in the fit, leaving only a constant delivery
// bias (folded into -o, exactly as raw arrival is). Then, using the firmware's cycle counts,
//   PPS host time = fit(sof_frame) + (dwt_pps - dwt_sof) / f_dwt.
// This is the macOS SOF correlation reproduced in pure userspace — no root, no usbmon, no kernel
// module — from fields already on the wire. On macOS we run it beside the IOKit anchor purely to
// measure it against hardware truth (reg_dsum/dsq below); production there still uses IOKit.
#define REG_WIN 300          // ~5 min of 1 Hz samples in the fit window
#define REG_MIN 40           // fit is trusted only past this many samples (else caller uses arrival)
static double reg_frame[REG_WIN], reg_tarr[REG_WIN];
static int    reg_n=0, reg_idx=0;
static double reg_mono_frame=0;                 // running unwrapped 11-bit frame count
static int    reg_have_prev=0; static unsigned reg_prev_raw=0; static double reg_prev_epoch=0;
static double reg_rate=1000.0;                  // frames/sec estimate, for wrap disambiguation
static double reg_dsum=0, reg_dsq=0; static long reg_dn=0;   // macOS validation: reg-vs-IOKit delta
static void reg_reset(void){ reg_n=0; reg_idx=0; reg_have_prev=0; reg_mono_frame=0; reg_rate=1000.0; }
// Feed one PPS sample; return the reconstructed PPS host-mono-ns, or NAN until REG_MIN history.
static double reg_pps_mono(unsigned sof_raw, uint32_t dwt_pps, uint32_t dwt_sof,
                           double epoch, double t_arr_mono, double f_dwt){
  if (!reg_have_prev){ reg_mono_frame = sof_raw; reg_have_prev = 1; }
  else {
    long dr = (long)((sof_raw - reg_prev_raw) & 0x7FF);       // 0..2047 low-side delta
    double egap = epoch - reg_prev_epoch;
    if (egap > 0.5 && egap < 3600){                           // place multi-second holes via epoch
      double k = (egap*reg_rate - (double)dr)/2048.0;         // wraps the &0x7FF mask hid
      dr += 2048L * (long)(k + (k>=0?0.5:-0.5));
      if (dr < 0) dr = (long)((sof_raw - reg_prev_raw) & 0x7FF);
    }
    reg_mono_frame += (double)dr;
  }
  reg_prev_raw = sof_raw; reg_prev_epoch = epoch;
  reg_frame[reg_idx]=reg_mono_frame; reg_tarr[reg_idx]=t_arr_mono;
  reg_idx=(reg_idx+1)%REG_WIN; if (reg_n<REG_WIN) reg_n++;
  if (reg_n < REG_MIN) return NAN;
  double Sx=0,Sy=0,Sxx=0,Sxy=0;
  for (int i=0;i<reg_n;i++){ double f=reg_frame[i],t=reg_tarr[i]; Sx+=f; Sy+=t; Sxx+=f*f; Sxy+=f*t; }
  double den = (double)reg_n*Sxx - Sx*Sx;
  if (den <= 0) return NAN;
  double b = ((double)reg_n*Sxy - Sx*Sy)/den;                 // ns per frame (~1e6)
  double a = (Sy - b*Sx)/reg_n;
  if (b > 0.5e6 && b < 2.0e6) reg_rate = 1e9/b;               // refine frames/sec from the slope
  double sof_mono = a + b*reg_mono_frame;                     // host mono-ns of this SOF (+const bias)
  return sof_mono + (double)(int32_t)(dwt_pps-dwt_sof)/f_dwt*1e9;
}

// ---- sample prefilter -----------------------------------------------------------------------------
// Raw per-second offsets carry ~tens-of-us scatter (SOF path) or worse (arrival path), plus rare
// large outliers from USB retries / IRQ preemption. chrony's refclock median filter handles neither
// one-sided tails nor slew-chasing well, so condition the stream here first:
//   gate      — reject any sample more than 3 robust-sigma (MAD-estimated over the last PF_WIN raw
//               offsets, 5 us floor) from the running median; outliers never reach chrony.
//   aggregate — accumulate PF_AGG accepted samples, send ONE sample per group: trimmed mean of the
//               offsets (drop top/bottom quarter) stamped at the group's centre time, so local
//               clock drift across the group cancels to first order.
// Scatter drops ~sqrt(PF_AGG) and chrony's updates stop chasing individual samples. -r bypasses.
#define PF_WIN 64
#define PF_AGG 8
static double pf_ring[PF_WIN]; static int pf_cnt=0, pf_idx=0;
static double pf_at[PF_AGG], pf_ao[PF_AGG]; static int pf_an=0;
static long   pf_rejects=0, pf_groups=0;
static void (*pf_sink)(double wall, double off) = NULL;   // production: chrony; self-test: recorder
static int dbl_cmp(const void *a, const void *b){
  double x=*(const double*)a, y=*(const double*)b; return x<y?-1:(x>y?1:0);
}
static double median_inplace(double *v, int n){
  qsort(v,n,sizeof(double),dbl_cmp);
  return (n&1) ? v[n/2] : 0.5*(v[n/2-1]+v[n/2]);
}
static void pf_reset(void){ pf_cnt=0; pf_idx=0; pf_an=0; }
static void pf_push(double wall, double off){
  int rejected = 0;
  if (pf_cnt >= 16){
    double tmp[PF_WIN], dev[PF_WIN];
    memcpy(tmp,pf_ring,pf_cnt*sizeof(double));
    double med = median_inplace(tmp,pf_cnt);
    for (int i=0;i<pf_cnt;i++) dev[i]=fabs(pf_ring[i]-med);
    double sig = 1.4826*median_inplace(dev,pf_cnt);       // MAD -> sigma for a normal core
    if (sig < 5e-6) sig = 5e-6;                           // floor: never gate tighter than 5 us
    if (fabs(off-med) > 3.0*sig){
      rejected = 1; pf_rejects++;
      if (opt_verb) fprintf(stderr,"[pccd] prefilter REJECT offset=%+11.6fs (median %+11.6fs, gate %.0fus)\n",off,med,3.0*sig*1e6);
    }
  }
  pf_ring[pf_idx]=off; pf_idx=(pf_idx+1)%PF_WIN; if (pf_cnt<PF_WIN) pf_cnt++;
  if (rejected) return;
  pf_at[pf_an]=wall; pf_ao[pf_an]=off; pf_an++;
  if (pf_an < PF_AGG) return;
  double o[PF_AGG]; memcpy(o,pf_ao,sizeof o);
  qsort(o,PF_AGG,sizeof(double),dbl_cmp);
  double so=0; for (int i=PF_AGG/4;i<PF_AGG-PF_AGG/4;i++) so+=o[i];
  so /= PF_AGG-2*(PF_AGG/4);
  double st=0; for (int i=0;i<PF_AGG;i++) st+=pf_at[i];
  st /= PF_AGG;
  pf_an=0; pf_groups++;
  if (pf_sink) pf_sink(st,so);
}
static double pt_off[16], pt_wall[16]; static int pt_n=0;
static void pf_test_sink(double wall, double off){ if (pt_n<16){ pt_wall[pt_n]=wall; pt_off[pt_n]=off; pt_n++; } }
static void pf_emit_chrony(double wall, double off){
  if (!opt_dry) chrony_send(wall,off);
  if (opt_verb || opt_dry)
    fprintf(stderr,"[pccd] avg%d offset=%+11.6fs (trimmed mean %s chrony)%s\n",
            PF_AGG, off, (g_chrony>=0&&!opt_dry)?"->":"-x", opt_dry?"  [dry]":"");
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
  // Prefilter vectors: 50 one-second samples around +100 us with +/-2 us deterministic noise and
  // two 5 ms outliers injected after warm-up. Expect: both outliers gated, 48 accepted samples ->
  // 6 groups of 8, every trimmed mean within 3 us of truth, centre times mid-group.
  pf_sink = pf_test_sink; pf_reset(); pf_rejects=0; pf_groups=0;
  pt_n=0;
  for (int i=0;i<50;i++){
    double off = 100e-6 + (double)(i%5 - 2)*1e-6;
    if (i==25) off = +5e-3;
    if (i==35) off = -5e-3;
    pf_push((double)i, off);
  }
  if (pf_rejects!=2){ fprintf(stderr,"prefilter FAIL: %ld outliers rejected (want 2)\n",pf_rejects); fail=1; }
  if (pt_n!=6){ fprintf(stderr,"prefilter FAIL: %d groups emitted (want 6)\n",pt_n); fail=1; }
  for (int i=0;i<pt_n;i++)
    if (fabs(pt_off[i]-100e-6) > 3e-6){ fprintf(stderr,"prefilter FAIL: group %d mean %+.6fs (want ~+0.000100s)\n",i,pt_off[i]); fail=1; }
  pf_sink = NULL; pf_reset(); pf_rejects=0; pf_groups=0;
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
  fcntl(fd, F_SETFD, FD_CLOEXEC);                       // don't leak the listener to subprocesses or across execv
  int one=1; setsockopt(fd,SOL_SOCKET,SO_REUSEADDR,&one,sizeof one);
  struct sockaddr_in a; memset(&a,0,sizeof a);
  a.sin_family=AF_INET; a.sin_port=htons((uint16_t)port);
  a.sin_addr.s_addr=htonl(INADDR_LOOPBACK);             // localhost ONLY — never exposed to the LAN
  if (bind(fd,(struct sockaddr*)&a,sizeof a)<0 || listen(fd,4)<0){ close(fd); return -1; }
  return fd;
}
// ---- optional static file server (-w) -------------------------------------------------------------
// Serve the PCC web app from a local directory so it loads over http://localhost:<port> — SAME ORIGIN
// as the bridge, which dodges the mixed-content wall Safari (and strict Chromium) throws up when the
// deployed https:// site tries to reach http://127.0.0.1. Web Serial is unaffected: the app keeps both
// transports; served locally it just prefers the (now same-origin) bridge.
static const char *mime_of(const char *path){
  const char *d = strrchr(path,'.'); if (!d) return "application/octet-stream";
  if (!strcmp(d,".html")) return "text/html; charset=utf-8";
  if (!strcmp(d,".js")||!strcmp(d,".mjs")) return "text/javascript";
  if (!strcmp(d,".css"))  return "text/css";
  if (!strcmp(d,".json")||!strcmp(d,".map")) return "application/json";
  if (!strcmp(d,".wasm")) return "application/wasm";       // must be exact for streaming compile
  if (!strcmp(d,".woff2"))return "font/woff2";
  if (!strcmp(d,".woff")) return "font/woff";
  if (!strcmp(d,".png"))  return "image/png";
  if (!strcmp(d,".svg"))  return "image/svg+xml";
  if (!strcmp(d,".ico"))  return "image/x-icon";
  return "application/octet-stream";                       // .bin (tzmap/tzrules) etc.
}
static void http_simple(Client *c, const char *status, const char *type, const char *body){
  char h[256]; int n=snprintf(h,sizeof h,
    "HTTP/1.1 %s\r\nContent-Type: %s\r\nContent-Length: %zu\r\nConnection: close\r\n\r\n%s",
    status,type,strlen(body),body);
  write(c->fd,h,n); close(c->fd); c->fd=-1;
}
// GET <reqpath> from opt_webroot. reqpath is caller-validated (leading '/', no ".."). Streams so the
// 12 MB tzmap doesn't need buffering. Blocking writes are fine on loopback.
static void serve_file(Client *c, const char *reqpath){
  char full[1600];
  snprintf(full,sizeof full,"%s%s",opt_webroot, reqpath[1]?reqpath:"/index.html");
  int fd = open(full,O_RDONLY);
  if (fd<0){ http_simple(c,"404 Not Found","text/plain","not found\n"); return; }
  struct stat st;
  if (fstat(fd,&st)!=0 || !S_ISREG(st.st_mode)){ close(fd); http_simple(c,"404 Not Found","text/plain","not found\n"); return; }
  char hdr[512];
  int hn=snprintf(hdr,sizeof hdr,
    "HTTP/1.1 200 OK\r\nContent-Type: %s\r\nContent-Length: %lld\r\n%sConnection: close\r\n\r\n",
    mime_of(full),(long long)st.st_size,
    strstr(full,".html")?"Cache-Control: no-cache\r\n":"");   // index stays fresh; assets are ?v-versioned
  if (write(c->fd,hdr,hn)>0){
    char buf[65536]; ssize_t r;
    while ((r=read(fd,buf,sizeof buf))>0){
      for (ssize_t off=0; off<r; ){ ssize_t w=write(c->fd,buf+off,r-off); if (w<=0){ r=-1; break; } off+=w; }
      if (r<0) break;
    }
  }
  close(fd); close(c->fd); c->fd=-1;
}

// A WebSocket handshake is NOT gated by the same-origin policy — any web page can open ws://127.0.0.1,
// so the loopback bind alone doesn't stop a foreign site from driving the clock or triggering an update.
// Accept only: no Origin (a non-browser client), a loopback page (us, or a localhost dev server), or the
// hosted app. `o` is "scheme://host[:port][/...]"; match the host exactly so http://localhost.evil.com fails.
static int origin_ok(const char *o){
  if (!*o) return 1;                                     // no Origin header (native/CLI ws client)
  if (!strcmp(o,"https://peterlewis.github.io")) return 1;
  const char *h = strstr(o,"://"); if (!h) return 0; h += 3;
  static const char *loop[] = { "localhost", "127.0.0.1", "[::1]" };
  for (unsigned i=0;i<sizeof loop/sizeof *loop;i++){ size_t n=strlen(loop[i]);
    if (!strncmp(h,loop[i],n) && (h[n]==0 || h[n]==':' || h[n]=='/')) return 1; }
  return 0;
}

// Quote a string as a single POSIX-sh word ('...', with embedded ' escaped as '\''), so a path or URL
// containing a quote or shell metacharacter can't break out of the system()/popen() strings in self_update.
static void shq(char *out, size_t cap, const char *in){
  size_t o=0; if (o+1<cap) out[o++]='\'';
  for (; *in; in++){
    if (*in=='\''){ const char *e="'\\''"; while (*e && o+1<cap) out[o++]=*e++; }
    else if (o+1<cap) out[o++]=*in;
  }
  if (o+1<cap) out[o++]='\'';
  out[o<cap?o:cap-1]=0;
}

// One HTTP request per plain connection: /health JSON (CORS-open so the deployed app can probe us),
// a WebSocket upgrade, an optional served file (-w), or a short status page.
static void http_or_upgrade(Client *c){
  c->buf[c->len]=0;
  if (!strstr(c->buf,"\r\n\r\n")) return;               // wait for full headers
  char *key = strcasestr(c->buf,"Sec-WebSocket-Key:");   // header names arrive in any case (undici: lowercase)
  if (key){
    // CSRF gate: reject a cross-origin browser before completing the upgrade.
    char *org = strcasestr(c->buf,"Origin:");
    if (org){
      org += 7; while (*org==' ') org++;
      char o[200]; int oi=0; while (*org && *org!='\r' && *org!='\n' && oi<(int)sizeof o-1) o[oi++]=*org++;
      o[oi]=0;
      if (!origin_ok(o)){
        fprintf(stderr,"[pccd] rejected websocket from origin %s\n",o);
        http_simple(c,"403 Forbidden","text/plain","cross-origin websocket rejected\n"); return;
      }
    }
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
    char hello[600]; snprintf(hello,sizeof hello,"#PCCD v1 device=%s",g_devpath);
    ws_send_text(c,hello,(int)strlen(hello));
    fprintf(stderr,"[pccd] websocket client connected\n");
    return;
  }
  // Parse the request path: "GET <path> HTTP/1.1".
  char path[1024]; path[0]=0;
  if (!strncmp(c->buf,"GET ",4)){
    const char *p=c->buf+4, *sp=strchr(p,' ');
    int len = sp ? (int)(sp-p) : 0;
    if (len>0 && len<(int)sizeof path){ memcpy(path,p,len); path[len]=0; }
  }
  char *q=strchr(path,'?'); if (q) *q=0;                    // drop the query string

  if (!strncmp(path,"/health",7)){
    // liveness, not just presence: is the tty open, when did the last accepted PPS land, what was
    // it, and how many samples have flowed vs been rejected — so the app can tell a streaming clock
    // from one that unplugged (serial_open:false) or went quiet (last_sample_age_s grows unbounded).
    char json[900], agebuf[32], offbuf[32];
    if (g_last_sample_mono>0){
      snprintf(agebuf,sizeof agebuf,"%.3f",(now_mono_ns()-g_last_sample_mono)*1e-9);
      snprintf(offbuf,sizeof offbuf,"%.9f",g_last_offset);
    } else { snprintf(agebuf,sizeof agebuf,"null"); snprintf(offbuf,sizeof offbuf,"null"); }
    snprintf(json,sizeof json,
      "{\"pccd\":1,\"version\":\"" PCCD_VERSTR "\",\"device\":\"%s\",\"chrony\":%s,"
      "\"serial_open\":%s,\"last_sample_age_s\":%s,\"last_offset_s\":%s,\"sent\":%ld,\"rejected\":%ld,"
      "\"updatable\":%s,\"platform\":\"%s\"}",
      g_devpath, (g_chrony>=0)?"true":"false",
      g_serial_open?"true":"false", agebuf, offbuf, g_nsent, g_nseen-g_nsent,
      g_updatable?"true":"false", g_platform?g_platform:"");
    char resp[1024];
    int n=snprintf(resp,sizeof resp,
      "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: *\r\n"
      "Content-Length: %zu\r\nConnection: close\r\n\r\n%s",strlen(json),json);
    write(c->fd,resp,n); close(c->fd); c->fd=-1; return;
  }
  if (opt_webroot && path[0]=='/' && !strstr(path,"..")){   // serve the app (same-origin)
    serve_file(c,path); return;
  }
  http_simple(c,"200 OK","text/plain",
    "pccd: Precision Clock bridge. WebSocket here; GET /health for status.\n");
}
static int  self_update(int dry, Client *cli);   // defined below main's helpers; a "pccd:" control frame calls it
static void upd_progress(Client *cli, const char *msg);
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
    if (op==0x9){                                               // ping -> pong
      // RFC 6455 §5.1: server->client frames MUST NOT be masked. Build a fresh unmasked pong
      // (control frames carry <=125 bytes) rather than echoing the client's masked frame back.
      unsigned char pong[2+125]; int pl = plen>125 ? 125 : plen;
      pong[0]=0x8A; pong[1]=(unsigned char)pl;                  // FIN|pong, mask bit clear
      for (int i=0;i<pl;i++) pong[2+i] = masked ? (unsigned char)(b[off+i]^mask[i&3]) : b[off+i];
      if (write(c->fd,pong,2+pl)<0){ close(c->fd); c->fd=-1; return; }
    }
    if (op==0x1){                                              // text: a command line
      char cmd[300]; int n = plen<(int)sizeof cmd-2 ? plen : (int)sizeof cmd-2;
      for (int i=0;i<n;i++) cmd[i] = masked ? (char)(b[off+i]^mask[i&3]) : (char)b[off+i];
      cmd[n]=0;
      // strip any client newline, send with the firmware's expected CRLF
      while (n>0 && (cmd[n-1]=='\n'||cmd[n-1]=='\r')) cmd[--n]=0;
      if (n>0){
        if (!strncmp(cmd,"pccd:",5)){                          // bridge control, NOT a clock command
          if      (!strcmp(cmd,"pccd:update"))     self_update(0,c);   // may exec/exit → never returns on success
          else if (!strcmp(cmd,"pccd:update-dry")) self_update(1,c);
          else upd_progress(c,"error unknown-control");
        } else if (serial_fd>=0){
          write(serial_fd,cmd,n); write(serial_fd,"\r\n",2);
        }
      }
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

// Absolute, symlink-resolved path of THIS executable → out (returns 0 / -1). The self-update swap and
// the bundled-app lookup both need to know where we actually live on disk.
static int exe_realpath(char *out, size_t cap){
  char exe[4096];
#ifdef __APPLE__
  uint32_t n=sizeof exe; if (_NSGetExecutablePath(exe,&n)!=0) return -1;
#else
  ssize_t k=readlink("/proc/self/exe",exe,sizeof exe-1); if (k<=0) return -1; exe[k]=0;
#endif
  char real[4096]; if (!realpath(exe,real)) return -1;
  if (strlen(real) >= cap) return -1;
  strcpy(out,real); return 0;
}

// If -w wasn't given, look for a PCC web app shipped ALONGSIDE the binary — the release tarball lays
// pccd next to a pcc-web/ dir. Serving it makes localhost:<port> a SAME-ORIGIN home for the app, so
// the bridge WebSocket works in EVERY browser: Safari/Firefox block a hosted https page from reaching
// a ws://127.0.0.1 loopback (mixed content), but a same-origin page dodges that wall entirely.
// Returns a static path buffer or NULL. Checked next to the exe: pcc-web/, then ../share/pcc/web/.
static const char *find_bundled_app(void){
  static char root[4096];
  char real[4096]; if (exe_realpath(real,sizeof real)!=0) return NULL;
  char *slash=strrchr(real,'/'); if(!slash) return NULL; *slash=0;   // -> the exe's directory
  const char *rel[]={ "/pcc-web", "/../share/pcc/web" };
  for (unsigned i=0;i<sizeof rel/sizeof *rel;i++){
    char idx[4300]; struct stat st;
    snprintf(root,sizeof root,"%s%s",real,rel[i]);
    snprintf(idx,sizeof idx,"%s/index.html",root);
    if (stat(idx,&st)==0 && S_ISREG(st.st_mode)) return root;
  }
  return NULL;
}

// ---- self-update ---------------------------------------------------------------------------------
// Compare two "MAJOR.MINOR" versions, ignoring a leading "pccd-v"/"v" and any "+githash" suffix.
// <0 if a<b, 0 equal, >0 if a>b.
static int ver_cmp(const char *a, const char *b){
  while (*a && (*a<'0'||*a>'9')) a++;
  while (*b && (*b<'0'||*b>'9')) b++;
  int amaj=0,amin=0,bmaj=0,bmin=0;
  sscanf(a,"%d.%d",&amaj,&amin); sscanf(b,"%d.%d",&bmaj,&bmin);
  if (amaj!=bmaj) return amaj-bmaj;
  return amin-bmin;
}
// One progress line → the requesting WebSocket client (as "pccd:update <msg>") and the log.
static void upd_progress(Client *cli, const char *msg){
  fprintf(stderr,"[pccd] update: %s\n",msg);
  if (cli && cli->fd>=0){ char f[200]; int n=snprintf(f,sizeof f,"pccd:update %s",msg); ws_send_text(cli,f,n); }
}
// Pull the latest release tarball for THIS platform, verify it, atomically swap our own binary + the
// bundled app, and relaunch. Every fetch/verify step gates BEFORE anything on disk is touched, so a
// failure leaves the install exactly as it was. `dry` runs the whole pipeline but stops before the
// swap. Returns 0 = swapped (process re-execs/exits), <0 = error (untouched), >0 = already current.
// Only shells out to `curl`/`tar`/`shasum` with compile-time-constant and mkdtemp-generated paths —
// nothing user-derived reaches a shell, so there is no injection surface.
static int self_update(int dry, Client *cli){
  if (!g_updatable){
    upd_progress(cli, g_platform ? "error not-a-tarball-install (run the downloaded pccd, no -w)"
                                 : "error self-update unavailable in this build");
    return -1;
  }
  char self[4096]; if (exe_realpath(self,sizeof self)!=0){ upd_progress(cli,"error cannot-locate-self"); return -1; }
  char dir[4096]; snprintf(dir,sizeof dir,"%s",self);
  char *slash=strrchr(dir,'/'); if(!slash){ upd_progress(cli,"error bad-exe-path"); return -1; } *slash=0;

  // Stage inside the install dir so every rename() below is same-filesystem (atomic, no cross-device copy).
  char tmp[4096]; snprintf(tmp,sizeof tmp,"%s/.pccd-update-XXXXXX",dir);
  if (!mkdtemp(tmp)){ upd_progress(cli,"error mkdtemp"); return -1; }

  const char *base=getenv("PCCD_UPDATE_BASE");                          // test seam; unset in production
  if (!base || !*base) base="https://github.com/peterlewis/pcc/releases/latest/download";
  // Everything below shells out to curl/tar/shasum. Quote every non-constant path/URL as one sh word (shq)
  // so an install path or base URL containing a quote/metacharacter can't break out of the command string.
  char qbase[8300], qtmp[8300];
  shq(qbase,sizeof qbase,base); shq(qtmp,sizeof qtmp,tmp);
  char cmd[16384]; int rc=-1; char nver[64]={0};
  do {
    upd_progress(cli,"downloading");
    snprintf(cmd,sizeof cmd,"curl -fsSL %s/pccd-%s.tar.gz -o %s/pcc.tgz",qbase,g_platform,qtmp);
    if (system(cmd)!=0){ upd_progress(cli,"error download-failed (need curl + network)"); break; }
    // SHA-256, fail CLOSED: a release always ships SHA256SUMS, so a missing/failed fetch means refuse —
    // never install unverified. (The -t + strictly-newer gates below are independent belt-and-braces.)
    snprintf(cmd,sizeof cmd,"curl -fsSL %s/SHA256SUMS -o %s/SHA256SUMS 2>/dev/null",qbase,qtmp);
    if (system(cmd)!=0){ upd_progress(cli,"error sha256sums-unavailable (refusing unverified install)"); break; }
    snprintf(cmd,sizeof cmd,
      "cd %s && H=$(command -v shasum >/dev/null 2>&1 && shasum -a 256 pcc.tgz || sha256sum pcc.tgz) && "
      "got=${H%%%% *} && want=$(awk '/pccd-%s\\.tar\\.gz/{print $1}' SHA256SUMS) && "
      "[ -n \"$want\" ] && [ \"$got\" = \"$want\" ]", qtmp, g_platform);
    if (system(cmd)!=0){ upd_progress(cli,"error sha256-mismatch"); break; }
    upd_progress(cli,"extracting");
    snprintf(cmd,sizeof cmd,"tar xzf %s/pcc.tgz -C %s",qtmp,qtmp);
    if (system(cmd)!=0){ upd_progress(cli,"error extract-failed"); break; }
    char nbin[4200], qnbin[8300]; struct stat st;
    snprintf(nbin,sizeof nbin,"%s/pcc/pccd",tmp);
    if (stat(nbin,&st)!=0){ upd_progress(cli,"error no-binary-in-tarball"); break; }
    chmod(nbin,0755); shq(qnbin,sizeof qnbin,nbin);
    upd_progress(cli,"verifying");
    snprintf(cmd,sizeof cmd,"%s -t >/dev/null 2>&1",qnbin);            // GATE 1: new binary passes its own self-test
    if (system(cmd)!=0){ upd_progress(cli,"error new-binary-failed-selftest"); break; }
    snprintf(cmd,sizeof cmd,"%s --version 2>/dev/null",qnbin);         // GATE 2: strictly newer than us
    FILE *vp=popen(cmd,"r"); if (vp){ if(!fgets(nver,sizeof nver,vp)) nver[0]=0; pclose(vp); }
    nver[strcspn(nver,"\r\n")]=0;
    if (ver_cmp(nver,PCCD_VERSTR) <= 0){
      char m[160]; snprintf(m,sizeof m,"already-current (have %s, latest %s)",PCCD_VERSTR,nver[0]?nver:"?");
      upd_progress(cli,m); rc=1; break;
    }
    if (dry){ char m[160]; snprintf(m,sizeof m,"dry-run OK — would update %s -> %s",PCCD_VERSTR,nver); upd_progress(cli,m); rc=0; break; }
    // ---- swap ----
    upd_progress(cli,"installing");
    // Binary: hard-link the old aside for rollback, then ONE atomic rename replaces `self`. rename() swaps
    // the directory entry in a single step, so the exec path is never absent — a crash mid-swap still boots.
    char bak[4200]; snprintf(bak,sizeof bak,"%s.bak",self);
    unlink(bak); if (link(self,bak)!=0){ /* backup best-effort; the atomic rename below is what matters */ }
    if (rename(nbin,self)!=0){ upd_progress(cli,"error binary-swap-failed"); break; }   // on failure `self` is untouched
    chmod(self,0755);
    // App: swap whatever we actually serve — opt_webroot is <dir>/pcc-web OR the FHS ../share/pcc/web.
    char nweb[4200]; snprintf(nweb,sizeof nweb,"%s/pcc/pcc-web",tmp);
    if (opt_webroot && stat(nweb,&st)==0){
      char webbak[4300], qwebbak[8500]; snprintf(webbak,sizeof webbak,"%s.old",opt_webroot);
      shq(qwebbak,sizeof qwebbak,webbak);
      snprintf(cmd,sizeof cmd,"rm -rf %s",qwebbak); if(system(cmd)){}
      if (rename(opt_webroot,webbak)!=0){                              // couldn't stash current app — install directly
        if (rename(nweb,opt_webroot)!=0) upd_progress(cli,"warn app-not-swapped (binary updated)");
      } else if (rename(nweb,opt_webroot)!=0){
        rename(webbak,opt_webroot);                                    // restore the stash
        upd_progress(cli,"warn app-not-swapped (binary updated)");
      } else { snprintf(cmd,sizeof cmd,"rm -rf %s",qwebbak); if(system(cmd)){} }
    }
    rc=0;
  } while(0);

  snprintf(cmd,sizeof cmd,"rm -rf %s",qtmp); if(system(cmd)){}          // clean the staging dir
  if (rc!=0) return rc;                                                 // error / already-current: keep running

  if (!cli){   // CLI one-shot (`pccd --update`): the on-disk install is updated; there's no running daemon to relaunch here.
    fprintf(stderr,"[pccd] update complete — installed the new version. Start pccd (or restart its service) to run it.\n");
    return 0;
  }
  upd_progress(cli,"done — restarting on the new version");
  // Daemon self-relaunch: execv preserves the PID, so a launchd/systemd supervisor keeps tracking this
  // job (no KeepAlive dependency, no restart gap); g_argv are the daemon's own args, minus any --update.
  // The long-lived sockets are FD_CLOEXEC, so the fresh image re-binds the port and re-opens the tty cleanly.
  execv(self,g_argv);
  upd_progress(cli,"error execv-failed — restart pccd to finish");
  return -1;
}

int main(int argc, char **argv){
  g_argv = argv;                          // saved for an execv() relaunch after a standalone self-update
  char devbuf[512]={0};   // roomy: /dev/serial/by-id/ symlinks can be long
  int opt_do_update=0, opt_update_dry=0;
  static const char USAGE[] =
    "usage: pccd [-d dev] [-p port] [-s chrony.sock] [-w webroot] [-o trim_s] [-n] [-v] [-r] [-t] [-T] [-h]\n"
    "  -d dev    serial device (default: auto-pick cu.usbmodem* / STM32 by-id / ttyACM*)\n"
    "  -p port   HTTP/WebSocket port on 127.0.0.1, 1..65535 (default 4192)\n"
    "  -s path   chrony SOCK path (default /var/run/chrony.pcc.sock)\n"
    "  -w dir    serve the PCC web app from this dir (same-origin bridge)\n"
    "  -o secs   fixed offset trim added to every sample\n"
    "  -n        dry run: compute offsets, never write to chrony\n"
    "  -v        verbose per-sample logging\n"
    "  -r        raw: bypass the sample prefilter\n"
    "  -t        self-test and exit\n"
    "  -T        USB frame-clock probe and exit (macOS)\n"
    "  --version print the version and exit\n"
    "  --update  update to the latest release, then relaunch (tarball installs only)\n"
    "  -h        print this help and exit\n";
  for (int i=1;i<argc;i++){
    const char *a=argv[i];
    if (!strcmp(a,"-h") || !strcmp(a,"--help")){ fputs(USAGE,stdout); return 0; }
    else if (!strcmp(a,"--version")){ puts(PCCD_VERSTR); return 0; }
    else if (!strcmp(a,"--update")) opt_do_update=1;
    else if (!strcmp(a,"--self-update-dry")) opt_do_update=opt_update_dry=1;   // fetch+verify, but don't swap
    else if (!strcmp(a,"-n")) opt_dry=1;
    else if (!strcmp(a,"-v")) opt_verb=1;
    else if (!strcmp(a,"-r")) opt_raw=1;
    else if (!strcmp(a,"-t")) return self_test();
    else if (!strcmp(a,"-T")) return frame_probe();
    else if (!strcmp(a,"-d")||!strcmp(a,"-p")||!strcmp(a,"-s")||!strcmp(a,"-o")||!strcmp(a,"-w")){
      if (i+1>=argc){ fprintf(stderr,"[pccd] missing value for %s\n%s",a,USAGE); return 2; }
      const char *val=argv[++i];
      if (!strcmp(a,"-d")) opt_dev=val;
      else if (!strcmp(a,"-s")) opt_sock=val;
      else if (!strcmp(a,"-o")) opt_trim=atof(val);
      else if (!strcmp(a,"-w")){ opt_webroot=val; opt_webroot_flag=1; }   // serve the PCC app same-origin (e07d308)
      else {                                              // -p: reject non-numeric / out-of-range ports
        char *end=NULL; long p=strtol(val,&end,10);
        if (!*val || (end && *end) || p<1 || p>65535){
          fprintf(stderr,"[pccd] invalid port '%s' (want 1..65535)\n",val); return 2; }
        opt_port=(int)p;
      }
    }
    else { fprintf(stderr,"[pccd] unknown option %s\n%s",a,USAGE); return 2; }
  }
  if (!opt_webroot) opt_webroot = find_bundled_app();   // release tarball ships pccd next to pcc-web/
  // Self-update is allowed only for a real downloaded tarball: platform baked in, app bundled alongside,
  // and no explicit -w (which marks a dev checkout). This keeps a developer's -w daemon untouched.
  g_updatable = (g_platform!=NULL) && !opt_webroot_flag && (opt_webroot!=NULL);
  if (opt_do_update) return self_update(opt_update_dry,NULL) < 0 ? 1 : 0;
  // A self-update leaves the previous binary at <self>.bak. Reap it only once THIS image proves it can
  // run (port bound + a short grace window below) — if a just-installed binary crashes on boot, launchd
  // never lets it reach that point, so the known-good .bak survives for a manual `mv pccd.bak pccd`.
  char bakpath[4200]=""; double bak_reap_at=0;
  { char self[4096]; if (exe_realpath(self,sizeof self)==0) snprintf(bakpath,sizeof bakpath,"%s.bak",self); }
  pf_sink = pf_emit_chrony;
  init_mono();
  signal(SIGINT,on_sig); signal(SIGTERM,on_sig); signal(SIGPIPE,SIG_IGN);
  for (int i=0;i<MAXCLI;i++) g_cli[i].fd=-1;

  g_listen = listen_open(opt_port);
  if (g_listen<0){ fprintf(stderr,"[pccd] cannot listen on 127.0.0.1:%d\n",opt_port); return 1; }
  if (bakpath[0]) bak_reap_at = now_mono_ns() + 15e9;   // port bound → arm the rollback-copy reap
  fprintf(stderr,"[pccd] v" PCCD_VERSTR " — http/ws on http://127.0.0.1:%d  (health: /health)%s\n",opt_port,opt_dry?"  [DRY RUN]":"");
  if (opt_webroot) fprintf(stderr,"[pccd] serving the PCC app from %s\n[pccd]   -> open http://localhost:%d in ANY browser, then CONNECT DEVICE\n",opt_webroot,opt_port);
  else fprintf(stderr,"[pccd] no bundled app found next to this binary — open the hosted app in a Chromium\n[pccd]   browser (it will use this bridge), or pass -w <web-dir> to serve the app same-origin\n");

  int sfd=-1; double next_retry=0;
  char line[512]; int li=0, overrun=0;
  double f_dwt=80e6; int haveRate=0; uint32_t prevDwt=0; int havePrev=0;

  while (!g_stop){
    double t_iter = now_mono_ns();   // spin-guard: iteration start; did_serial gates the floor sleep
    int did_serial = 0;
    if (bakpath[0] && t_iter > bak_reap_at){ unlink(bakpath); bakpath[0]=0; }   // update proven healthy → drop rollback copy
    // Self-heal the $PMTXTS stream: port open but nothing landing for 60 s → re-assert `pps = on`.
    // Covers a clock reboot (back to the pps=off config default), a reflash, and any app that switched
    // it off behind our back. Costs one 10-byte write a minute in the worst case (no GPS lock).
    if (sfd>=0 && t_iter - g_last_ppson > 60e9 &&
        (g_last_sample_mono==0 || t_iter - g_last_sample_mono > 60e9)) pps_assert(sfd);
    // (re)open serial + USB interface — the clock re-enumerates on config edits and firmware flashes,
    // so treat disconnection as routine and retry quietly.
    if (sfd<0 && now_mono_ns()>next_retry){
      const char *dev = opt_dev;
      if (!dev && serial_autopick(devbuf,sizeof devbuf)==0) dev=devbuf;
      if (dev && (sfd=serial_open(dev))>=0){
        if (g_nodev_warned){ fprintf(stderr,"[pccd] clock reappeared: %s\n",dev); g_nodev_warned=0; }
        g_serial_open=1;
        pps_assert(sfd);                               // our feed, our switch — the clock boots with pps=off
        usb_close(); usb_open(0x0483,-1);               // STM32 VID; frame clock rides the same bus
#ifdef __APPLE__
        fprintf(stderr,"[pccd] serial open: %s%s\n",dev,g_usb?"":"  (no USB frame clock — arrival timestamps, ~ms accuracy)");
#else
        fprintf(stderr,"[pccd] serial open: %s  (arrival timestamps — Linux has no USB frame clock; ~ms accuracy)\n",dev);
#endif
        havePrev=0; haveRate=0; li=0; overrun=0; pf_reset(); reg_reset();
      } else {
        // Nothing to open. Say so ONCE per outage (mirrors the chrony-EACCES warn-once above): a
        // launchd pccd otherwise logs the listen banner then goes silent — same signature as a hang.
        if (!g_nodev_warned){
          g_nodev_warned = 1;
          if (opt_dev)
            fprintf(stderr,"[pccd] waiting for %s (cannot open yet) — retrying every 2s\n",opt_dev);
          else
#ifdef __APPLE__
            fprintf(stderr,"[pccd] no clock found (looked for /dev/cu.usbmodem*) — retrying every 2s\n");
#else
            fprintf(stderr,"[pccd] no clock found (looked for /dev/serial/by-id/*STM32* then /dev/ttyACM*) — retrying every 2s\n");
#endif
        }
        next_retry = now_mono_ns()+2e9;
      }
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
        fcntl(fd, F_SETFD, FD_CLOEXEC);
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
    // serial — POLLNVAL matters: a USB-serial node that vanishes oddly on re-enumeration (a flash /
    // replug, routine here) can leave an fd that poll() reports as INVALID rather than HUP. Without
    // POLLNVAL in the mask that fd is never drained or closed, so poll returns it ready every
    // iteration and the loop pegs a core. Treating it like any other loss closes + backs off cleanly.
    if (iSer>=0 && (pf[iSer].revents & (POLLIN|POLLHUP|POLLERR|POLLNVAL))){
      double rx_mono = now_mono_ns();                    // arrival stamp for the frame-clock fallback
      char chunk[256];
      int r=(int)read(sfd,chunk,sizeof chunk);
      if (r<=0){ fprintf(stderr,"[pccd] serial lost — will retry\n"); close(sfd); sfd=-1; g_serial_open=0; usb_close(); li=0; overrun=0; next_retry=now_mono_ns()+2e9; continue; }
      did_serial=1;
      for (int i=0;i<r;i++){
        char ch=chunk[i];
        if (ch=='\n'){
          if (overrun){ overrun=0; li=0; continue; }     // this '\n' just closes a dropped over-long line
          line[li]=0; int len=li; li=0;
          if (!len) continue;
          broadcast_line(line);                          // every line goes to every PCC tab
          if (len>8 && !strncmp(line,"$PMTXTS,",8)){
            uint64_t hf; double hmono; int gotF=(usb_frame(&hf,&hmono)==0);
            Pmtxts x;
            if (parse_pmtxts(line,&x)==0){
              g_nseen++;
              if (x.ext && havePrev){ int32_t d=(int32_t)(x.dwt_pps-prevDwt);
                if (d>60000000 && d<100000000){ f_dwt = haveRate ? 0.9*f_dwt+0.1*d : (double)d; haveRate=1; } }
              if (x.ext){ prevDwt=x.dwt_pps; havePrev=1; }
              if ((x.flags & 3) == 3){                   // require valid(b0)+pps(b1); rtc(b2) NOT required
                double pps_wall; const char *how;
                // Portable SOF-regression anchor (runs on every platform when the SOF fields + a
                // DWT-rate estimate are present). NAN until it has REG_MIN history.
                double reg_mono = (x.ext && haveRate)
                  ? reg_pps_mono(x.sof_frame, x.dwt_pps, x.dwt_sof, (double)x.epoch, rx_mono, f_dwt)
                  : NAN;
                if (x.ext && gotF && haveRate){
                  // IOKit hardware anchor — macOS production, and the ground truth we grade the
                  // regression against: place the named frame on the host clock, step DWT to the edge.
                  long dframe=(long)((x.sof_frame-(unsigned)(hf&0x7FF))&0x7FF);
                  if (dframe>1024) dframe-=2048;
                  double sof_mono = hmono + (double)dframe*1.0e6;             // 1 frame = 1 ms
                  double pps_mono = sof_mono + (double)(int32_t)(x.dwt_pps-x.dwt_sof)/f_dwt*1e9;
                  pps_wall = wall_of_mono_ns(pps_mono); how="sof";
                  if (!isnan(reg_mono)){ double d=pps_mono-reg_mono; reg_dsum+=d; reg_dsq+=d*d; reg_dn++; }
                } else if (!isnan(reg_mono)){
                  // No hardware frame clock (Linux) but the regression is warm — reconstruct the edge.
                  pps_wall = wall_of_mono_ns(reg_mono); how="reg";
                } else {
                  // Cold start / no SOF fields: the sentence lands a few ms after the edge it names.
                  pps_wall = wall_of_mono_ns(rx_mono); how="arr";
                }
                double offset = (double)x.epoch - pps_wall + opt_trim;        // true - system
                if (offset>-0.5 && offset<0.5){
                  if (opt_raw){ if (!opt_dry) chrony_send(pps_wall,offset); }
                  else pf_push(pps_wall,offset);
                  g_nsent++;
                  g_last_sample_mono = now_mono_ns();    // liveness stamp for /health
                  g_last_offset = offset;
                  if (opt_verb || opt_dry)
                    fprintf(stderr,"[pccd] pps seq=%lu offset=%+11.6fs [%s] (host %s chrony)%s\n",
                            x.seq, offset, how, (g_chrony>=0&&!opt_dry)?"->":"-x",
                            opt_dry?"  [dry]":"");
                } else if (opt_verb)
                  fprintf(stderr,"[pccd] pps seq=%lu offset=%+.3fs [%s] REJECTED (sanity: check epoch/NTP)\n",x.seq,offset,how);
              } else if (opt_verb){
                // distinct from the sanity/range reject above: the sample failed the flags gate
                fprintf(stderr,"[pccd] pps seq=%lu flags=0x%lx REJECTED (need valid+pps; b0=%ld b1=%ld b2=%ld)\n",
                        x.seq, (unsigned long)x.flags, x.flags&1L, (x.flags>>1)&1L, (x.flags>>2)&1L);
              }
            }
          }
        } else if (overrun){
          continue;                                      // still discarding an over-long line
        } else if (li>=(int)sizeof line-1){
          // buffer full with no newline: drop this line and everything up to the next '\n' rather than
          // force-terminating and broadcasting a mid-sentence fragment (plus its tail as a second line)
          overrun=1;
          if (opt_verb) fprintf(stderr,"[pccd] serial line exceeded %d bytes — dropping to next newline\n",(int)sizeof line-1);
        } else if (ch!='\r'){ line[li++]=ch; }
      }
    }
    // Spin guard (defence in depth): if an iteration did no serial work in under 1 ms, poll() is
    // returning a persistently-ready-but-unproductive fd — an un-drainable serial node, or a
    // half-dead ws client — so sleep 5 ms to cap the loop at ~200 Hz instead of pegging a core. A
    // 500 ms poll timeout (idle) or any serial byte (live data) makes the iteration longer / sets
    // did_serial, so this never throttles real traffic or adds latency to a flowing clock.
    if (!did_serial && now_mono_ns()-t_iter < 1.0e6){ struct timespec ts={0,5*1000*1000}; nanosleep(&ts,NULL); }
  }
  fprintf(stderr,"[pccd] exiting — %ld PPS samples processed, %ld usable, %ld sent as avg%d groups, %ld outliers rejected\n",g_nseen,g_nsent,pf_groups,PF_AGG,pf_rejects);
  if (reg_dn>0){ double m=reg_dsum/reg_dn, v=reg_dsq/reg_dn-m*m; if(v<0)v=0;
    fprintf(stderr,"[pccd] SOF-regression vs IOKit anchor: n=%ld  bias=%+.1fus  jitter(RMS about mean)=%.1fus\n",reg_dn,m*1e-3,sqrt(v)*1e-3); }
  if (sfd>=0) close(sfd);
  usb_close();
  if (g_chrony>=0) close(g_chrony);
  if (g_listen>=0) close(g_listen);
  return 0;
}
