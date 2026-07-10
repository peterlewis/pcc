# pccd — builds on macOS (clang + IOKit) and Linux (gcc/clang, no dependencies).
CFLAGS ?= -O2 -Wall -Wextra
UNAME  := $(shell uname -s)
ifeq ($(UNAME),Darwin)
LDLIBS = -framework IOKit -framework CoreFoundation
endif

pccd: pccd.c
	$(CC) $(CFLAGS) -o $@ pccd.c $(LDLIBS)
	./pccd -t

install: pccd
	install -m 755 pccd /usr/local/bin/pccd
	@echo "installed /usr/local/bin/pccd — see README.md for the chrony refclock line"

clean:
	rm -f pccd
