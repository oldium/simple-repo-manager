#!/bin/bash
# Build the synthetic fixture packages and capture what reprepro and
# createrepo_c publish for them. Run from the repository root:
#   bash tests/fixtures/build-fixtures.sh
# Needs Docker (debian:trixie, ubuntu:noble, fedora:42) and the compose stack.
set -euo pipefail

[[ -f compose.yaml ]] || { echo "run from the repository root" >&2; exit 1; }

fixtures=tests/fixtures
# Windows path for docker -v under Git Bash, plain pwd elsewhere
host_fixtures="$(cd "${fixtures}" && (pwd -W 2>/dev/null || pwd))"

rm -rf "${fixtures}/packages" "${fixtures}/packages-arm64" "${fixtures}/packages-udeb" "${fixtures}/golden"

# Runs the script on stdin in a throwaway container with tests/fixtures at /fixtures
build_in() {
    MSYS_NO_PATHCONV=1 docker run --rm -i -e "HOST_UID=$(id -u)" -e "HOST_GID=$(id -g)" \
        -v "${host_fixtures}:/fixtures" "$1" bash -eu -o pipefail -s
}

# ---------------------------------------------------------------------------
# debian:trixie: srm-hello (xz, amd64 + all + arm64 binary-only + udeb) and
# srm-gz (gzip, bookworm)
# ---------------------------------------------------------------------------
build_in debian:trixie <<'EOF'
export DEBIAN_FRONTEND=noninteractive
apt-get -qq update
apt-get -qq install -y --no-install-recommends dpkg-dev >/dev/null
mtime='2026-10-28 10:00:00 UTC'
tar_opts=(--sort=name --owner=0 --group=0 --numeric-owner --mtime="${mtime}")
collect() { mkdir -p "$2"; find "$1" -maxdepth 1 -type f -exec mv -t "$2" {} +; }

# --- srm-hello 1.0-1 -------------------------------------------------------
mkdir -p /build/hello/srm-hello-1.0/debian/source
cd /build/hello/srm-hello-1.0
printf '#!/bin/sh\necho hello\n' > hello
printf 'srm-hello documentation\n' > README
echo '3.0 (quilt)' > debian/source/format
cat > debian/control <<'CTL'
Source: srm-hello
Section: utils
Priority: optional
Maintainer: Simple Repo Manager <srm@example.com>
Rules-Requires-Root: no
Standards-Version: 4.7.2

Package: srm-hello
Architecture: any
Depends: srm-hello-doc (>= ${source:Version})
Description: Hello script

Package: srm-hello-doc
Architecture: all
Section: doc
Description: Hello script documentation

Package: srm-hello-udeb
Package-Type: udeb
Section: debian-installer
Architecture: any
Build-Profiles: <udeb>
Description: Hello script for the installer
CTL
cat > debian/changelog <<'CHG'
srm-hello (1.0-1) trixie; urgency=medium

  * Initial release.

 -- Simple Repo Manager <srm@example.com>  Wed, 28 Oct 2026 10:00:00 +0000
CHG
cat > debian/rules <<'RULES'
#!/usr/bin/make -f
# dpkg-dev only, no debhelper: keeps the packages at a few hundred bytes
ARCH := $(shell dpkg-architecture -qDEB_HOST_ARCH)
DEBVERSION := $(shell dpkg-parsechangelog -SVersion | sed 's/^[0-9]*://')

build build-arch build-indep:

clean:
	rm -rf debian/files debian/srm-hello debian/srm-hello-doc debian/srm-hello-udeb

binary: binary-arch binary-indep

ifneq (,$(filter udeb,$(DEB_BUILD_PROFILES)))
binary-arch:
	install -D -m 755 hello debian/srm-hello-udeb/usr/bin/srm-hello
	mkdir -p debian/srm-hello-udeb/DEBIAN
	dpkg-gencontrol -psrm-hello-udeb -Pdebian/srm-hello-udeb
	dpkg-deb -Zxz -b debian/srm-hello-udeb ../srm-hello-udeb_$(DEBVERSION)_$(ARCH).udeb
else
binary-arch:
	install -D -m 755 hello debian/srm-hello/usr/bin/srm-hello
	mkdir -p debian/srm-hello/DEBIAN
	dpkg-gencontrol -psrm-hello -Pdebian/srm-hello
	dpkg-deb -Zxz -b debian/srm-hello ..
endif

binary-indep:
	install -D -m 644 README debian/srm-hello-doc/usr/share/doc/srm-hello-doc/README
	mkdir -p debian/srm-hello-doc/DEBIAN
	dpkg-gencontrol -psrm-hello-doc -Pdebian/srm-hello-doc
	dpkg-deb -Zxz -b debian/srm-hello-doc ..
RULES
chmod +x debian/rules
tar "${tar_opts[@]}" --exclude=srm-hello-1.0/debian -C /build/hello -czf /build/hello/srm-hello_1.0.orig.tar.gz srm-hello-1.0

dpkg-buildpackage -us -uc -d
collect /build/hello /fixtures/packages/deb/debian/trixie/main

dpkg-buildpackage -B --host-arch=arm64 -d -us -uc
collect /build/hello /fixtures/packages-arm64/deb/debian/trixie/main

# The udeb is a bundle of its own: reprepro rejects a .changes carrying a udeb
# unless UDebComponents is configured, which the server never does
dpkg-buildpackage -B -d -us -uc -Pudeb \
    --changes-file=../srm-hello-udeb_1.0-1_amd64.changes \
    --buildinfo-file=../srm-hello-udeb_1.0-1_amd64.buildinfo
collect /build/hello /fixtures/packages-udeb/deb/debian/trixie/main

# --- srm-gz 0.1-1 ----------------------------------------------------------
mkdir -p /build/gz/srm-gz-0.1/debian/source
cd /build/gz/srm-gz-0.1
printf '#!/bin/sh\necho gz\n' > gz
printf 'naïve\n' > naive
echo '3.0 (quilt)' > debian/source/format
cat > debian/control <<'CTL'
Source: srm-gz
Section: misc
Priority: optional
Maintainer: Simple Repo Manager <srm@example.com>
Rules-Requires-Root: no
Standards-Version: 4.7.2

Package: srm-gz
Architecture: any
Description: Gzip-compressed script
CTL
cat > debian/changelog <<'CHG'
srm-gz (0.1-1) bookworm; urgency=low

  * Initial release.

 -- Simple Repo Manager <srm@example.com>  Wed, 28 Oct 2026 10:00:00 +0000
CHG
cat > debian/rules <<'RULES'
#!/usr/bin/make -f
# dpkg-dev only, no debhelper: keeps the packages at a few hundred bytes

build build-arch build-indep:

clean:
	rm -rf debian/files debian/srm-gz

binary: binary-arch binary-indep

binary-arch:
	install -D -m 755 gz debian/srm-gz/usr/bin/srm-gz
	install -D -m 644 naive "debian/srm-gz/usr/share/srm-gz/naïve file"
	mkdir -p debian/srm-gz/DEBIAN
	dpkg-gencontrol -psrm-gz -Pdebian/srm-gz
	dpkg-deb -Zgzip -b debian/srm-gz ..

binary-indep:
RULES
chmod +x debian/rules
tar "${tar_opts[@]}" --exclude=srm-gz-0.1/debian -C /build/gz -czf /build/gz/srm-gz_0.1.orig.tar.gz srm-gz-0.1

dpkg-buildpackage -us -uc -d -Zgzip
collect /build/gz /fixtures/packages/deb/debian/bookworm/main

chown -R "${HOST_UID}:${HOST_GID}" /fixtures/packages /fixtures/packages-arm64 /fixtures/packages-udeb 2>/dev/null || true
EOF

# ---------------------------------------------------------------------------
# ubuntu:noble: srm-zst (zstd, epoch, ddeb)
# ---------------------------------------------------------------------------
build_in ubuntu:noble <<'EOF'
export DEBIAN_FRONTEND=noninteractive
apt-get -qq update
apt-get -qq install -y --no-install-recommends dpkg-dev >/dev/null
tar_opts=(--sort=name --owner=0 --group=0 --numeric-owner --mtime='2026-10-28 10:00:00 UTC')

mkdir -p /build/zst/srm-zst-3.0/debian/source
cd /build/zst/srm-zst-3.0
printf '#!/bin/sh\necho zst\n' > zst
printf 'not an ELF\n' > zst.debug
echo '3.0 (quilt)' > debian/source/format
cat > debian/control <<'CTL'
Source: srm-zst
Section: utils
Priority: standard
Maintainer: Simple Repo Manager <srm@example.com>
Rules-Requires-Root: no
Standards-Version: 4.7.2

Package: srm-zst
Architecture: any
Depends: bash (>= 5)
Description: Zstd-compressed script
CTL
cat > debian/changelog <<'CHG'
srm-zst (2:3.0-1) noble; urgency=medium

  * Initial release.

 -- Simple Repo Manager <srm@example.com>  Wed, 28 Oct 2026 10:00:00 +0000
CHG
# Control of the ddeb, crafted with dpkg-deb instead of debug symbols
cat > debian/dbgsym.control <<'CTL'
Package: srm-zst-dbgsym
Source: srm-zst
Version: 2:3.0-1
Auto-Built-Package: debug-symbols
Architecture: @ARCH@
Maintainer: Simple Repo Manager <srm@example.com>
Installed-Size: 5
Depends: srm-zst (= 2:3.0-1)
Section: debug
Priority: optional
Description: debug symbols for srm-zst
CTL
cat > debian/rules <<'RULES'
#!/usr/bin/make -f
# dpkg-dev only, no debhelper: keeps the packages at a few hundred bytes
ARCH := $(shell dpkg-architecture -qDEB_HOST_ARCH)
DEBVERSION := $(shell dpkg-parsechangelog -SVersion | sed 's/^[0-9]*://')
DDEB := srm-zst-dbgsym_$(DEBVERSION)_$(ARCH).ddeb

build build-arch build-indep:

clean:
	rm -rf debian/files debian/srm-zst debian/srm-zst-dbgsym

binary: binary-arch binary-indep

binary-arch:
	install -D -m 755 zst debian/srm-zst/usr/bin/srm-zst
	mkdir -p debian/srm-zst/DEBIAN
	dpkg-gencontrol -psrm-zst -Pdebian/srm-zst
	dpkg-deb -Zzstd -b debian/srm-zst ..
	install -D -m 644 zst.debug debian/srm-zst-dbgsym/usr/lib/debug/.build-id/4a/1b2c3d.debug
	mkdir -p debian/srm-zst-dbgsym/DEBIAN
	sed 's/@ARCH@/$(ARCH)/' debian/dbgsym.control > debian/srm-zst-dbgsym/DEBIAN/control
	dpkg-deb -Zzstd -b debian/srm-zst-dbgsym ../$(DDEB)
	dpkg-distaddfile $(DDEB) debug optional

binary-indep:
RULES
chmod +x debian/rules
tar "${tar_opts[@]}" --exclude=srm-zst-3.0/debian -C /build/zst -cJf /build/zst/srm-zst_3.0.orig.tar.xz srm-zst-3.0

dpkg-buildpackage -us -uc -d
out=/fixtures/packages/deb/ubuntu/noble/universe
mkdir -p "${out}"
find /build/zst -maxdepth 1 -type f -exec mv -t "${out}" {} +
chown -R "${HOST_UID}:${HOST_GID}" /fixtures/packages 2>/dev/null || true
EOF

# ---------------------------------------------------------------------------
# fedora:42: srm-hello src.rpm, x86_64 and noarch doc
# ---------------------------------------------------------------------------
build_in fedora:42 <<'EOF'
dnf -y -q install rpm-build
export SOURCE_DATE_EPOCH=1793181600
top=/build
mkdir -p "${top}/SOURCES" "${top}/SPECS"
printf '#!/bin/sh\necho hello\n' > "${top}/SOURCES/srm-hello"
printf 'greeting=hello\n' > "${top}/SOURCES/srm-hello.conf"
printf 'srm-hello documentation\n' > "${top}/SOURCES/README"
cat > "${top}/SPECS/srm-hello.spec" <<'SPEC'
%global debug_package %{nil}
%define _build_id_links none
%define _buildhost srm.example.com
%define use_source_date_epoch_as_buildtime 1
%define clamp_mtime_to_source_date_epoch 1

Name:           srm-hello
Version:        1.0
Release:        1%{?dist}
Summary:        Hello script
License:        MIT
URL:            https://example.com/srm-hello
Source0:        srm-hello
Source1:        srm-hello.conf
Source2:        README
Requires(pre):  shadow-utils
Requires(post): shadow-utils
Requires(postun): coreutils
Requires:       bash
Recommends:     srm-hello-doc = %{version}-%{release}
Provides:       srm-greeter = 0.9
Obsoletes:      srm-greet < 0.9

%description
Hello script.

%package doc
Summary:        Hello script documentation
BuildArch:      noarch

%description doc
Hello script documentation.

%prep

%build

%install
install -D -m 755 %{SOURCE0} %{buildroot}%{_bindir}/srm-hello
install -D -m 644 %{SOURCE1} %{buildroot}%{_sysconfdir}/srm-hello.conf
install -D -m 644 %{SOURCE2} %{buildroot}%{_docdir}/srm-hello-doc/README

%files
%{_bindir}/srm-hello
%config(noreplace) %{_sysconfdir}/srm-hello.conf
%ghost %{_localstatedir}/log/srm-hello.log

%files doc
%{_docdir}/srm-hello-doc/README

%changelog
SPEC
# 12 entries, newest first
for m in $(seq 12 -1 1); do
    if [ "${m}" = 12 ]; then v=1.0-1; else v="0.${m}-1"; fi
    printf '* %s SRM <srm@example.com> - %s\n- Change %d\n\n' \
        "$(date -u -d "2025-${m}-01" '+%a %b %d %Y')" "${v}" "${m}" >> "${top}/SPECS/srm-hello.spec"
done

rpmbuild -ba --define "_topdir ${top}" --define "dist .fc42" "${top}/SPECS/srm-hello.spec"
out=/fixtures/packages/rpm/fedora/42
mkdir -p "${out}"
cp "${top}"/RPMS/*/*.rpm "${top}"/SRPMS/*.rpm "${out}/"
chown -R "${HOST_UID}:${HOST_GID}" /fixtures/packages 2>/dev/null || true
EOF

# ---------------------------------------------------------------------------
# Golden output from the current stack
# ---------------------------------------------------------------------------
conf=data/repo-state/deb-debian/conf
reprepro() { docker compose exec -T simple-repo-manager reprepro --confdir "+b/${conf}" "$@"; }
# Points conf/incoming at the process dir of one debian release
debian_incoming() {
    cat > "${conf}/incoming" <<INC
Name: $1
IncomingDir: data/incoming/process/deb/debian/$2/main
TempDir: data/repo-state/deb-debian/tmp-$2
Allow: $2
Permit: older_version
INC
}

# The server copies every .changes architecture into Architectures: and reprepro
# refuses 'all' there, so the stack leaves deb-debian unprocessed; finish it by hand
bash tests/e2e/capture-golden.sh "${fixtures}/packages" tmp/golden-synth || true
sed -i -E '/^Architectures:/{s/ all( |$)/\1/}' "${conf}/distributions"
for release in trixie bookworm; do
    [[ -n "$(ls -A "data/incoming/process/deb/debian/${release}/main" 2>/dev/null)" ]] || continue
    debian_incoming debian "${release}"
    reprepro processincoming debian
done

# Decompressed text indexes under canonical names, written from the container
# because the host may lack zstd
export_golden='
export_golden() {
    local src=$1 dst=$2 f rel dir name cmd
    find "$src" -type f \( -path "*/dists/*" -o -path "*/repodata/*" \) | sort | while read -r f; do
        rel=${f#"$src"/}
        dir=$(dirname "$rel")
        name=$(basename "$f")
        case "$name" in InRelease|Release.gpg|repomd.xml.asc) continue ;; esac
        case "$dir" in */repodata) name=${name#*-} ;; esac
        case "$name" in
            *.gz)  name=${name%.gz};  cmd="gzip -dc" ;;
            *.xz)  name=${name%.xz};  cmd="xz -dc" ;;
            *.zst) name=${name%.zst}; cmd="zstd -dc" ;;
            *.bz2) name=${name%.bz2}; cmd="bzip2 -dc" ;;
            *) cmd=cat ;;
        esac
        [ -e "$dst/$dir/$name" ] && continue
        mkdir -p "$dst/$dir"
        $cmd "$f" > "$dst/$dir/$name"
    done
}
'
docker compose exec -T simple-repo-manager bash -eu -o pipefail -c "${export_golden}
rm -rf /app/data/golden-export
export_golden /app/data/repo /app/data/golden-export
"

# ---------------------------------------------------------------------------
# udeb golden: reprepro by hand with UDebComponents (and udeb Contents) on the
# udeb bundle
# ---------------------------------------------------------------------------
awk '/^Codename: trixie$/ { t = 1 } /^$/ { t = 0 }
     t && /^Contents:/ { print "Contents: udebs"; next }
     { print }
     t && /^Components:/ { print "UDebComponents: main" }' \
    "${conf}/distributions" > "${conf}/distributions.udeb"
mv "${conf}/distributions.udeb" "${conf}/distributions"
debian_incoming udeb trixie
mkdir -p data/incoming/process/deb/debian/trixie/main
cp "${fixtures}"/packages-udeb/deb/debian/trixie/main/* data/incoming/process/deb/debian/trixie/main/
reprepro processincoming udeb
docker compose exec -T simple-repo-manager bash -eu -o pipefail -c "${export_golden}
export_golden /app/data/repo/deb/debian/dists/trixie /app/data/golden-export/udeb/deb/debian/dists/trixie
"

mkdir -p "${fixtures}/golden"
cp -r data/golden-export/. "${fixtures}/golden/"
rm -rf data/golden-export

for f in deb/debian/dists/trixie/main/binary-amd64/Packages deb/debian/dists/bookworm/main/Contents-amd64 \
         deb/ubuntu/dists/noble/universe/debug/binary-amd64/Packages rpm/fedora/42/repodata/primary.xml \
         udeb/deb/debian/dists/trixie/main/debian-installer/binary-amd64/Packages \
         udeb/deb/debian/dists/trixie/main/Contents-udeb-amd64; do
    [[ -f "${fixtures}/golden/${f}" ]] || { echo "missing golden/${f}" >&2; exit 1; }
done
du -sh "${fixtures}"
