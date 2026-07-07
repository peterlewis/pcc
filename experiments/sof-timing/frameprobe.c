// frameprobe.c — de-risk the HOST side of the SOF-correlation timestamp experiment.
//
// The whole scheme hinges on one question: can userspace on macOS read the USB frame number
// together with a hardware host-timestamp of the SOF that carried it? If yes, we can anchor the
// device's per-SOF DWT latches to host wall-clock and place the 1PPS edge on the host timeline to
// microseconds — regardless of when our software actually reads the serial packet.
//
// This probe finds a USB device, grabs its IOUSBDeviceInterface, and calls
// GetBusFrameNumberWithTime() in a burst. Success criteria:
//   1. the call returns kIOReturnSuccess (the API is reachable without owning the device), and
//   2. the frame number advances ~1 per millisecond with a monotonic host time.
// That's the host capability the experiment needs. No clock/firmware required to prove it.
//
// Build:  clang -O2 frameprobe.c -o frameprobe -framework IOKit -framework CoreFoundation
// Run:    ./frameprobe                 (probes the first usable device)
//         ./frameprobe 0x0483 0x5740   (target a specific VID PID, e.g. the Mk IV once attached)

#include <IOKit/IOKitLib.h>
#include <IOKit/IOCFPlugIn.h>
#include <IOKit/usb/IOUSBLib.h>
#include <CoreFoundation/CoreFoundation.h>
#include <mach/mach_time.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static double mach_to_ns_scale(void) {
    mach_timebase_info_data_t tb; mach_timebase_info(&tb);
    return (double)tb.numer / (double)tb.denom;
}

// AbsoluteTime is a {hi,lo} pair in mach-absolute-time units.
static uint64_t abstime_u64(AbsoluteTime t) {
    return ((uint64_t)t.hi << 32) | (uint32_t)t.lo;
}

int main(int argc, char **argv) {
    long wantV = (argc > 1) ? strtol(argv[1], NULL, 0) : -1;
    long wantP = (argc > 2) ? strtol(argv[2], NULL, 0) : -1;
    double ns = mach_to_ns_scale();

    io_iterator_t it;
    if (IOServiceGetMatchingServices(kIOMainPortDefault,
            IOServiceMatching(kIOUSBDeviceClassName), &it) != kIOReturnSuccess) {
        fprintf(stderr, "no USB device iterator\n"); return 2;
    }

    io_service_t dev;
    IOUSBDeviceInterface500 **usb = NULL;
    char devname[128] = "?";
    UInt16 vid = 0, pid = 0;

    while ((dev = IOIteratorNext(it))) {
        // read VID/PID for reporting / matching
        CFTypeRef v = IORegistryEntryCreateCFProperty(dev, CFSTR("idVendor"),  kCFAllocatorDefault, 0);
        CFTypeRef p = IORegistryEntryCreateCFProperty(dev, CFSTR("idProduct"), kCFAllocatorDefault, 0);
        UInt16 dv = 0, dp = 0;
        if (v) { CFNumberGetValue(v, kCFNumberSInt16Type, &dv); CFRelease(v); }
        if (p) { CFNumberGetValue(p, kCFNumberSInt16Type, &dp); CFRelease(p); }
        if (wantV >= 0 && (dv != wantV || (wantP >= 0 && dp != wantP))) { IOObjectRelease(dev); continue; }

        IOCFPlugInInterface **plugin = NULL; SInt32 score = 0;
        if (IOCreatePlugInInterfaceForService(dev, kIOUSBDeviceUserClientTypeID,
                kIOCFPlugInInterfaceID, &plugin, &score) == kIOReturnSuccess && plugin) {
            (*plugin)->QueryInterface(plugin,
                CFUUIDGetUUIDBytes(kIOUSBDeviceInterfaceID500), (LPVOID *)&usb);
            (*plugin)->Release(plugin);
        }
        if (usb) {
            // Probe the actual call BEFORE committing to this device.
            UInt64 frame = 0; AbsoluteTime at; memset(&at, 0, sizeof at);
            if ((*usb)->GetBusFrameNumberWithTime(usb, &frame, &at) == kIOReturnSuccess) {
                vid = dv; pid = dp;
                io_name_t nm; if (IORegistryEntryGetName(dev, nm) == kIOReturnSuccess) strncpy(devname, nm, sizeof devname - 1);
                IOObjectRelease(dev);
                break;   // found a device whose bus answers the query
            }
            (*usb)->Release(usb); usb = NULL;
        }
        IOObjectRelease(dev);
    }
    IOObjectRelease(it);

    if (!usb) {
        fprintf(stderr, "No USB device answered GetBusFrameNumberWithTime.\n"
                        "(Plug in any USB device; a root hub alone may not expose the user client.)\n");
        return 1;
    }

    printf("device: %s  VID=0x%04x PID=0x%04x\n", devname, vid, pid);
    printf("proving frame<->host-time: 24 reads over ~24 ms\n");
    printf("  %-6s  %-16s  %-10s  %-10s\n", "frame", "host_ns", "dframe", "dhost_us");

    UInt64 f0 = 0, prevF = 0; uint64_t prevNs = 0; int first = 1;
    int advancing = 0, samples = 0;
    for (int i = 0; i < 24; i++) {
        UInt64 frame = 0; AbsoluteTime at; memset(&at, 0, sizeof at);
        IOReturn r = (*usb)->GetBusFrameNumberWithTime(usb, &frame, &at);
        if (r != kIOReturnSuccess) { printf("  read %d failed: 0x%x\n", i, r); break; }
        uint64_t hns = (uint64_t)(abstime_u64(at) * ns);
        if (first) { f0 = frame; prevF = frame; prevNs = hns; first = 0; }
        long df = (long)(frame - prevF);
        double dus = (double)((int64_t)hns - (int64_t)prevNs) / 1000.0;
        printf("  %-6llu  %-16llu  %-10ld  %-10.1f\n",
               (unsigned long long)frame, (unsigned long long)hns, df, dus);
        if (i > 0 && frame > prevF) advancing++;
        if (i > 0) samples++;
        prevF = frame; prevNs = hns;
        usleep(1000);   // ~1 ms; frame should tick ~+1
    }

    UInt64 fN = prevF;
    printf("\nsummary: frame advanced %llu counts across the burst; %d/%d reads advanced.\n",
           (unsigned long long)(fN - f0), advancing, samples);
    printf("VERDICT: %s\n", (fN > f0) ?
        "PASS — host can read (USB frame, host-time). SOF correlation is viable on this Mac." :
        "INCONCLUSIVE — frame did not advance; try a different/active USB device.");

    (*usb)->Release(usb);
    return (fN > f0) ? 0 : 1;
}
