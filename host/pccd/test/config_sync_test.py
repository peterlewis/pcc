# config_sync_test.py: pccd writes the clock's menu choices into config.txt, end to end.
# The clock is a pseudo-terminal and its drive is a temporary folder (PCCD_DRIVE), so this needs no
# clock and touches no real file. It checks that pccd asks for the choices, applies a $PMCFG set to
# config.txt (in place, comments kept, a backup made, a "# synced" line added), writes nothing for a
# set the file already satisfies, and ignores a damaged set.
# Run: python3 test/config_sync_test.py ./pccd        (from host/pccd, after make)
import os, pty, subprocess, sys, time, tempfile, select, shutil, glob
pccd = sys.argv[1]
work = tempfile.mkdtemp(prefix="pccd-sync-")
drive = os.path.join(work, "CLOCK"); hist = os.path.join(work, "hist"); os.makedirs(drive); os.makedirs(hist)
cfg = os.path.join(drive, "config.txt")
orig = "# my clock\r\nMODE_ISO8601_STD = enabled\r\nMODE_UNIX = enabled\r\npage_ms = 2000\r\nbrightness = 2000\r\n"
open(cfg, "w", newline="").write(orig)
master, slave = pty.openpty()
env = dict(os.environ, PCCD_DRIVE=drive)
p = subprocess.Popen([pccd, "-d", os.ttyname(slave), "-p", "4197", "-n", "-H", hist], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
def sentence(body): 
    c = 0
    for ch in body: c ^= ord(ch)
    return ("$%s*%02X\r\n" % (body, c)).encode()
def read_from_pccd(seconds):
    buf = b""; end = time.time() + seconds
    while time.time() < end:
        r, _, _ = select.select([master], [], [], 0.1)
        if r:
            try: buf += os.read(master, 4096)
            except OSError: break
    return buf.decode(errors="replace")
results = []
def check(name, ok): results.append((name, ok)); print(("PASS  " if ok else "FAIL  ") + name)
try:
    got = read_from_pccd(8)                      # the drive scan runs every 5 s; the ask follows it
    check("pccd asks the clock for its menu choices (menu_export = on)", "menu_export = on" in got)
    items = [("page_ms","2250"), ("freq_hold","on"), ("MODE_UNIX","disabled"), ("brightness","")]
    for i,(k,v) in enumerate(items): os.write(master, sentence("PMCFG,5,%d,%s,%s" % (i+1,k,v)))
    os.write(master, sentence("PMCFG,5,0,END,%d" % len(items)))
    time.sleep(2.0)
    new = open(cfg, newline="").read()
    lines = new.split("\r\n")
    check("page_ms is rewritten where it stood", lines[3] == "page_ms = 2250")
    check("MODE_UNIX is rewritten", "MODE_UNIX = disabled" in lines and "MODE_UNIX = enabled" not in lines)
    check("the brightness line is removed (AUTO)", not any(l.startswith("brightness") for l in lines))
    check("freq_hold is added", "freq_hold = on" in lines)
    check("the comment and the untouched key are still there", lines[0] == "# my clock" and lines[1] == "MODE_ISO8601_STD = enabled")
    check("a sync comment records it", any(l.startswith("# synced ") and "4 settings from the clock's menu" in l for l in lines))
    check("the file keeps its CRLF line endings", "\n" not in new.replace("\r\n", ""))
    backups = glob.glob(os.path.join(hist, "config-backups", "config-*.txt"))
    check("the old file is kept as a backup", len(backups) == 1 and open(backups[0], newline="").read() == orig)
    check("no temporary file is left on the drive", sorted(os.listdir(drive)) == ["config.txt"])
    m1 = os.stat(cfg).st_mtime_ns
    # The clock reads the file, drops those choices, and reports what is left: only brightness on AUTO.
    os.write(master, sentence("PMCFG,6,1,brightness,")); os.write(master, sentence("PMCFG,6,0,END,1"))
    time.sleep(1.5)
    check("a set the file already satisfies writes nothing", os.stat(cfg).st_mtime_ns == m1 and open(cfg, newline="").read() == new)
    # A damaged set is not used.
    os.write(master, b"$PMCFG,7,1,page_ms,9999*00\r\n"); os.write(master, sentence("PMCFG,7,0,END,1"))
    os.write(master, sentence("PMCFG,8,2,page_ms,9999")); os.write(master, sentence("PMCFG,8,0,END,1"))
    time.sleep(1.5)
    check("a set with a bad checksum, or one that does not start at 1, is not used", open(cfg, newline="").read() == new)
finally:
    p.terminate()
    try: out = p.communicate(timeout=5)[0].decode(errors="replace")
    except Exception: p.kill(); out = ""
    log = [l for l in out.splitlines() if "config sync" in l]
    print("pccd log:", log)
    shutil.rmtree(work, ignore_errors=True)
fail = [n for n, ok in results if not ok]
print("\nALL PASS" if not fail and results else "\n%d FAIL" % len(fail))
sys.exit(1 if fail or not results else 0)
