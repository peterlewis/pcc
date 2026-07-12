# pccd — builds on macOS (clang + IOKit) and Linux (gcc/clang, no dependencies).
CFLAGS ?= -O2 -Wall -Wextra
UNAME  := $(shell uname -s)
# Stamp the build with the short git hash (when in a repo) for a traceable /health version.
GIT_HASH := $(shell git rev-parse --short HEAD 2>/dev/null)
ifneq ($(GIT_HASH),)
CFLAGS += -DPCCD_GIT=\"$(GIT_HASH)\"
endif
ifeq ($(UNAME),Darwin)
LDLIBS = -framework IOKit -framework CoreFoundation
else
LDLIBS = -lm
endif

pccd: pccd.c
	$(CC) $(CFLAGS) -o $@ pccd.c $(LDLIBS)
	./pccd -t

install: pccd
	install -m 755 pccd /usr/local/bin/pccd
	@echo "installed /usr/local/bin/pccd — see README.md for the chrony refclock line"

clean:
	rm -f pccd
