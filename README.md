# Simple Repository Manager

This is a [Node.js][nodejs] project providing a simple repository manager for
Debian and RedHat repository formats. It receives uploaded files by POST and
PUT HTTP methods, and builds, signs and serves the repositories itself, without
any external repository tools.

Features:

* 🖥️ Web UI to browse the uploaded files.
* ⌨️ Full support for keyboard and mouse navigation in the web UI.
* 🧩 Customizable installation instructions shown on every page with built-in
  Debian and RedHat templates.
* 🌓 Dark mode is supported 😉.
* 🚀 File upload by POST HTTP method.
* 🚀 File upload by PUT HTTP method compatible with Debian's `dput` and
  `dput-ng` tools.
* ✒️ Supports building a signed repository.
* 📦 Builds the Debian and RedHat repository metadata itself, rewriting only
  the indexes an upload or removal touches.
* 🔄 Acts as a simple indexer for uploads, every uploaded version stays in
  the repository index.
* ♻️ Allows re-uploading the same package version with different checksums,
  useful during development.
* ⏪ Supports uploading older versions than those already indexed.
* 🧱 Supports Debian `.deb`, `.ddeb` (debug symbols) and `.udeb`
  (debian-installer) packages.
* 🗑️ Supports removing packages from the repository via API, either
  immediately or after a one-day grace period.
* 🔁 Retains all package source files (including Debian `.changes` and
  `.buildinfo`) so they can be re-uploaded to another server.
* 🤖 Contains an embedded MCP (Model Context Protocol) server with a
  source-package-name oriented interface for agent clients.
* 🔓 Optionally opens the listing API and the MCP read tools to everybody,
  while uploads and removals stay protected.
* ✂️ Separates distributions (Debian vs. Ubuntu) and for RedHat-like
  repositories also releases (Fedora 41 vs. 42).
* 🎨 Supports multiple distributions and releases.
* 📂 Self-contained, serves the created repositories, a separate Nginx instance
  is not necessary.

The project follows a minimal approach — upload the files and import them, the
server does the rest. The repository state lives in a
[database](#repository-database), and the published repositories are generated
from it, so manual changes in the published files are not picked up. Use the
APIs instead, see details [below](#repository-management-api).

[nodejs]: https://nodejs.org

## Quick Start

This project was developed and tested with [Node.js][nodejs] version 26 and
[npm][npm]. Nothing else is needed, the server builds and signs the
repositories itself.

To install all Node.js development dependencies, run the following command:

```bash
npm install
```

The default configuration serves files from the local data directory `./data`,
so you can run the server with the following command:

```bash
npm run dev
```

This will start the server listening on http://localhost:3000.

The Development Container (devcontainer in short) comes with Node.js and the
`sqlite3` command-line tool for inspecting the repository database, so you can
test the server without installing anything on your local machine. Please
consult the relevant documentation for your IDE, like
[Visual Studio Code][vscode-devcontainer] or
[JetBrains WebStorm][jetbrains-devcontainer], to learn how to run the
Development Containers.

You can also run the production version based on the `Dockerfile` with Docker
Compose:

```bash
docker compose up --detach
```

This will build the local Docker image (from `Dockerfile`) and start local
server listening at http://localhost (port 80 is forwarded to container port
3000\) with local folder `./data` mounted to `/app/data` in the container.

[npm]: https://github.com/npm/cli/pull/8703#issuecomment-3452682658

[vscode-devcontainer]: https://code.visualstudio.com/docs/devcontainers/containers

[jetbrains-devcontainer]: https://www.jetbrains.com/help/webstorm/dev-containers-starting-page.html

## Usage

To use the repository manager, you need to follow these steps:

* Configure the server. See the [Configuration](#configuration) section below
  for details.
* Start the server. See the [Quick Start](#quick-start) section above for
  details.
* Upload the packages to the repository. See the
  [Packages Upload API](#packages-upload-api) section below for details.
* Import the uploads into the repository. See the
  [Repository Management API](#repository-management-api) section below for
  details.
* Use the repository in your distribution. See below for details on how to use
  the repository in Debian-like and RedHat-like distributions.
* Optionally, you can browse the repository using
  the [Repository Browser](#repository-browser)

### Debian-like Repository

The Debian-like repository is served at the following URI:

```url
<scheme>://<host>:<port>/deb/<distribution>/
```

The scheme depends on the configuration, it can be either `http` or `https`. For
signed repositories the GPG public key needs to be imported into the system
keyring. The public key is in the text form (“armored”) can be downloaded from
the following URI:

```url
<scheme>://<host>:<port>/deb/archive-keyring.asc
```

To set up the signed repository on the Debian-based distribution, you can use
the following command:

```bash
curl -fsSL <scheme>://<host>:<port>/deb/archive-keyring.asc | 
  sudo gpg --dearmor -o /etc/apt/trusted.gpg.d/my-repo.gpg
```

Then add the repository to the APT sources list:

```bash
sudo tee /etc/apt/sources.list.d/my-repo.sources >/dev/null <<'EOF'
Types: deb deb-src
URIs: <scheme>://<host>:<port>/deb/<distribution>/
Suites: <release>
Components: <component>
Signed-By: /etc/apt/trusted.gpg.d/my-repo.gpg
EOF
```

If you do not want to sign the repository, skip the `curl` command and omit the
`Signed-By:` line in the source list command. The repository can be accessed
without the GPG key, but it is not recommended for production use.

Now you can update the APT package index and install the packages from the
repository:

```bash
sudo apt update
sudo apt install <package>
```

The real-life example after you uploaded the fictitious package `foo` for Debian
distribution's release Bookworm and `main` component would look like this:

```bash
curl -fsSL https://my-repo.example.com/deb/archive-keyring.asc | sudo gpg --dearmor -o /etc/apt/trusted.gpg.d/my-repo.gpg
```

```bash
sudo tee /etc/apt/sources.list.d/my-repo.sources >/dev/null <<'EOF'
Types: deb deb-src
URIs: https://my-repo.example.com/deb/debian/
Suites: bookworm
Components: main
Signed-By: /etc/apt/trusted.gpg.d/my-repo.gpg
EOF
```

```bash
sudo apt update
sudo apt install foo
```

### RedHat-like Repository

The RedHat-like repository is served at the following URI:

```url
<scheme>://<host>:<port>/rpm/<distribution>/<release>/
```

The scheme depends on the configuration, it can be either `http` or `https`. For
signed repositories the GPG public key needs to be imported into the system
keyring. The public key is in the text form (“armored”) can be downloaded from
the following URI:

```url
<scheme>://<host>:<port>/rpm/RPM-GPG-KEY.asc
```

To set up the signed repository on the RedHat-based distribution, you can use
the following command:

```bash
sudo curl -fsSL <scheme>://<host>:<port>/rpm/RPM-GPG-KEY.asc -o /etc/pki/rpm-gpg/RPM-GPG-KEY-my-repo
```

Then add the repository to the YUM/DNF configuration:

```bash
sudo tee /etc/yum.repos.d/my-repo.repo >/dev/null <<'EOF'
[rpm-my-repo]
name=My Repository
baseurl=<scheme>://<host>:<port>/rpm/<distribution>/<release>/
enabled=1
gpgcheck=1
repo_gpgcheck=1
gpgkey=file:///etc/pki/rpm-gpg/RPM-GPG-KEY-my-repo
EOF
```

And register the GPG public key with the YUM/DNF keyring and update the
repository metadata:

```bash
sudo rpm --import /etc/pki/rpm-gpg/RPM-GPG-KEY-my-repo && \
sudo dnf -q makecache -y --disablerepo='*' --enablerepo=rpm-my-repo
```

This configuration expects that the packages are either signed with the
signature available in the repository public GPG key, or the packages signature
is already installed in the system keyring. If that is not the case and the
packages signature should not be verified, you can omit the `gpgcheck=1`
line.

If you do not have a signed repository at all, skip the `curl` command and omit
the `gpgcheck`, `repo_gpgcheck` and `gpgkey` lines in the repository
configuration. The repository can be accessed without the GPG key, but it is not
recommended for production use.

Now you can update the YUM/DNF package index and install the packages from the
repository:

```bash
sudo dnf check-update
sudo dnf install <package>
```

The real-life example after you uploaded the fictitious package `foo` for Fedora
release 41 would look like this:

```bash
sudo curl -fsSL https://my-repo.example.com/rpm/RPM-GPG-KEY.asc -o /etc/pki/rpm-gpg/RPM-GPG-KEY-my-repo
```

```bash
sudo tee /etc/yum.repos.d/my-repo.repo >/dev/null <<'EOF'
[rpm-my-repo]
name=My Repository
baseurl=https://my-repo.example.com/rpm/fedora/41/
enabled=1
gpgcheck=1
gpgpkey=file:///etc/pki/rpm-gpg/RPM-GPG-KEY-my-repo
EOF
```

```bash
sudo rpm --import /etc/pki/rpm-gpg/RPM-GPG-KEY-my-repo && \
sudo dnf -q makecache -y --disablerepo='*' --enablerepo=rpm-my-repo
```

```bash
sudo dnf check-update
sudo dnf install foo
```

## Repository Browser

The repository browser is a simple web interface to browse the uploaded files
after being transformed by the
[Repository Management API](#repository-management-api) into the repositories.
It is available at the root `/` path of the server. The browser is not meant to
be a full-featured repository browser, it is just a simple interface to see what
files are available in the repository and download them.

The browser is not protected by any authentication, so it is accessible to
anyone who has access to the server.

The browser can be accessed at the following URI:

```url
<scheme>://<host>:<port>/
```

The scheme depends on the configuration, it can be either `http` or `https`. For
the same example as in the [Usage](#usage) section, the browser could be
accessed at:

```url
https://my-repo.example.com/
```

## Status API

The status API is available at the `/status` endpoint. It serves as a
confirmation that the server is up and running. The status response is a simple
text response with no particular structure containing the information that the
server is running.

## Packages API

The packages API is designed to be used by tools like `dput`, `dput-ng` and
`curl`. It can be optionally protected by basic authentication. See the
[Configuration](#configuration) section for more details.

The packages API is versioned and the current path is `/api/v1`.

The response to all the packages API requests below the `/api` path is always
JSON with the fields described below and additional fields described in the
following sections:

* `message`: A human-readable message for the result of the operation.
* `correlation`: Optional unique identifier with the `id` field, which can be
  used to track the request in the server logs. Present only for HTTP response
  error status codes `400` and higher.

### Packages Status API

The status API is available at the `/api/v1/status` endpoint. It serves as a
confirmation that the authentication is correctly set up because the same rules
apply as for the upload APIs, unless `API_PUBLIC_READ` is set (see
[Configuration Examples](#configuration-examples)). The status response
contains the following fields:

* `message`: A message that the server is up and running.
* `api`: Dictionary with the following structure:
  * `deb`:
    * `enabled`: A boolean indicating that the Debian-like Upload API is
      enabled. Always `true`, both formats are built in.
  * `rpm`:
    * `enabled`: A boolean indicating that the RedHat-like Upload API is
      enabled. Always `true`, both formats are built in.

## Packages Upload API

The packages API is designed to be used by tools like `dput`, `dput-ng` and
`curl`. It can be optionally protected by basic authentication. See the
[Configuration](#configuration) section for more details.

The packages upload API is prefixed with `/api/v1/upload`.

The response to all the Upload API requests below the `/api/v1/upload` path is
always JSON with the following fields:

* `message`: A human-readable message describing the result of the upload.
* `files`: Optional array of uploaded files. Each entry contains the following
  fields:
  * `filename`: The name of the uploaded file.
  * `status`: The upload status, which can be `"ok"` or `"failed"`.
  * `path`: Optional path of the uploaded file without the `/api/v1/upload`
    prefix.
* `correlation`: Optional unique identifier with the `id` field, which can be
  used to track the request in the server logs. Present only for HTTP response
  error status codes `400` and higher.

### Debian Packages Upload API

> [!NOTE]
> The Debian Upload API is compatible with `dput` and `dput-ng` tools and can
> be used for uploading Debian-based distributions like Debian, Ubuntu, etc.

> [!IMPORTANT]
> A Debian upload bundle must include the `.changes` file plus every
> file it references (source `.dsc`, source tarballs, binary `.deb`
> / `.ddeb` / `.udeb`, and `.buildinfo`). Without the `.changes`,
> `import_repository` reports the directory's files with
> `status: "skipped"`; with a `.changes` whose files are missing or
> differ, it reports `status: "failed"`. Either way the files wait in
> `INCOMING_DIR`, and every later import retries them, so upload the
> missing files and call the import again.

The Repository Management API expects that all files have been uploaded
already. This means that the client must upload the
`<package>.changes` file and all files listed in the `<package>.changes` file.
For example, upload of the first packaged version of fictitious package `foo`
version `1.0` would require the following files (the full list of files varies
based on the source package and distribution):

* `foo_1.0-1_amd64.changes`
* `foo_1.0-1.dsc`
* `foo_1.0-1_amd64.deb`
* `foo-dbgsym_1.0-1_amd64.deb` or `foo-dbgsym_1.0-1_amd64.ddeb`
* `foo_1.0-1_amd64.buildinfo`
* `foo_1.0.orig.tar.gz`
* `foo_1.0-1.debian.tar.xz`

All files are stored in the repository, including the `.changes` and
`.buildinfo` files, so the bundle can be downloaded and uploaded to another
server. Debug symbol packages (`.ddeb`) are published in the
`<component>/debug/` indexes and debian-installer packages (`.udeb`) in the
`<component>/debian-installer/` indexes, with their files listed in
`<component>/Contents-udeb-<architecture>.gz`.

> [!IMPORTANT]
> The `<release>` in the URIs must be listed in the `Distribution:` tag of the
> `<package>.changes` file.
>
> For Debian-like repositories, the `Source:` and `Version:` tags are also
> validated before automatic same-version re-upload handling and must use only
> supported characters.

#### POST API

* `/api/v1/upload/deb/<distribution>/<release>/<component>`
* `/api/v1/upload/deb/<distribution>/<release>/<component>/<sub-component>`

The POST API expects a `multipart/form-data` request with the field `package`
(can be changed, see [Configuration](#configuration) section) containing the
uploaded files. In case of multiple files in the same request, the field name
must be `package` without any additional brackets. The `curl` tool can be used
to upload the files with the following command:

```bash
curl -u "<username>:<password>" \
  -F "package=@foo_1.0-1_amd64.changes" \
  -F "package=@foo_1.0-1.dsc" \
  -F "package=@foo_1.0-1_amd64.deb" \
  -F "package=@foo-dbgsym_1.0-1_amd64.deb" \
  -F "package=@foo_1.0-1_amd64.buildinfo" \
  -F "package=@foo_1.0.orig.tar.gz" \
  -F "package=@foo_1.0-1.debian.tar.xz" \
  https://<host>:<port>/api/v1/upload/deb/<distribution>/<release>/<component>
```

For example, to upload the package to Debian Bookworm distribution into
component `main`, the URI would look like:

```url
https://my-repo.example.com/api/v1/upload/deb/debian/bookworm/main`
```

To upload the file to the Debian Bookworm security update distribution and
component `updates/main`, one could use:

```url
https://my-repo.example.com/api/v1/upload/deb/debian/bookworm-security/updates/main`
```

For **testing** with plain HTTP and disabled authorization one could use
`http` instead of `https` and omit the `-u` argument with the username and
password:

```bash
curl -F "package=@foo_1.0-1_amd64.changes" \
  -F "package=@foo_1.0-1.dsc" \
  -F "package=@foo_1.0-1_amd64.deb" \
  -F "package=@foo-dbgsym_1.0-1_amd64.deb" \
  -F "package=@foo_1.0-1_amd64.buildinfo" \
  -F "package=@foo_1.0.orig.tar.gz" \
  -F "package=@foo_1.0-1.debian.tar.xz" \
  http://<host>:<port>/api/v1/upload/deb/<distribution>/<release>/<component>
```

#### PUT API

* `/api/v1/upload/deb/<distribution>/<release>/<component>/<file>`
* `/api/v1/upload/deb/<distribution>/<release>/<component>/<sub-component>/<file>`

The PUT API is meant to be used by `dput` and `dput-ng` tools. The example
`.dput.cf` corresponding to the section above for Debian Bookworm distribution
and `main` component could look like:

```ini
[bookworm-main]
fqdn=<username>:<password>@my-repo.example.com:443
incoming=/api/v1/upload/deb/debian/bookworm/main
method=https
distributions=bookworm
```

and call the `dput` tool with the following command:

```bash
dput bookworm-main foo_1.0-1_amd64.changes
```

Or in case of the Debian Bookworm security update distribution and component
`updates/main` one could use:

```ini
[bookworm-security-main]
fqdn=<username>:<password>@my-repo.example.com:443
incoming=/api/v1/upload/deb/debian/bookworm-security/updates/main
method=https
distributions=bookworm-security
```

and call the `dput` tool with the following command:

```bash
dput bookworm-security-main foo_1.0-1_amd64.changes
```

For **testing** with plain HTTP and disabled authorization one could use
`method=http` and omit the username and password from the `fqdn` parameter:

```ini
[bookworm-main-test]
fqdn=my-repo.example.com:80
incoming=/api/v1/upload/deb/debian/bookworm/main
method=http
distributions=bookworm
```

### RedHat-like Packages Upload API

The Repository Management API is not so strict like in the Debian-like
repository case, so it works even for single RPMs. Binary RPMs belong to the
source package named in their header, so the listing and removal APIs find
them with or without the `.src.rpm`. For the fictitious package `foo` version
`1.0` the following files could be uploaded to have both the source and binary
RPMs:

* `foo-1.0-1.x86_64.rpm`
* `foo-1.0-1.src.rpm`

The files are stored in the release directory under
`Packages/<first character of the source name>/<source name>/`, both directories
in lower case and the file name as uploaded, for example
`rpm/fedora/44/Packages/n/networkmanager/NetworkManager-1.56.0-1.fc44.x86_64.rpm`.

#### POST API

* `/api/v1/upload/rpm/<distribution>/<release>`

The POST API expects a `multipart/form-data` request with the field `package`
(can be changed, see [Configuration](#configuration) section) containing the
uploaded files. In case of multiple files in the same request, the field name
must be `package` without any additional brackets. The `curl` tool can be used
to upload the files with the following command:

```bash
curl -u "<username>:<password>" \
  -F "package=@foo-1.0-1.x86_64.rpm" \
  -F "package=@foo-1.0-1.src.rpm" \
  https://<host>:<port>/api/v1/upload/rpm/<distribution>/<release>
```

For example, to upload the package to Fedora release 41, the URI would look
like:

```url
https://my-repo.example.com/api/v1/upload/rpm/fedora/41`
```

For **testing** with plain HTTP and disabled authorization one could use
`http` instead of `https` and omit the `-u` argument with the username and
password:

```bash
curl -F "package=@foo-1.0-1.x86_64.rpm" \
  -F "package=@foo-1.0-1.src.rpm" \
  http://<host>:<port>/api/v1/upload/rpm/<distribution>/<release>
```

#### PUT API

* `/api/v1/upload/rpm/<distribution>/<release>/<file>`

The PUT API accepts single file uploads. The `curl` tool can be used to upload
the file:

```bash
curl -u "<username>:<password>" \
  -T "foo-1.0-1.x86_64.rpm" \
  https://<host>:<port>/api/v1/upload/rpm/<distribution>/<release>/foo-1.0-1.x86_64.rpm
```

For example, to upload the package to Fedora release 41, the URI would look
like:

```url
https://my-repo.example.com/api/v1/upload/rpm/fedora/41/foo-1.0-1.x86_64.rpm
```

If the URI ends with a slash `/`, the file name is appended by `curl`
automatically:

```bash
curl -u "<username>:<password>" \
  -T "foo-1.0-1.x86_64.rpm" \
  https://<host>:<port>/api/v1/upload/rpm/<distribution>/<release>/
```

So in the same example as above, one would use:

```url
https://my-repo.example.com/api/v1/upload/rpm/fedora/41/
```

It is also possible to upload multiple files in multiple requests with a single
command:

```bash
curl -u "<username>:<password>" \
  -T "{foo-1.0-1.x86_64.rpm,foo-1.0-1.src.rpm}" \
  https://<host>:<port>/api/v1/upload/rpm/<distribution>/<release>/
```

For **testing** with plain HTTP and disabled authorization one could use
`http` instead of `https` and omit the `-u` argument with the username and
password:

```bash
curl -T "foo-1.0-1.x86_64.rpm" \
  http://<host>:<port>/api/v1/upload/rpm/<distribution>/<release>/
```

### Repository Management API

To build the repository from the uploaded files, send the `POST` request to the
`/api/v1/repo/import` endpoint. There is nothing read from the request body, so
it might be empty.

The repository build can be triggered by issuing the following `curl` command:

```bash
curl -u "<username>:<password>" \
  -X POST https://<host>:<port>/api/v1/repo/import
```

For **testing** with plain HTTP and disabled authorization one could use `http`
instead of `https` and omit the `-u` argument with the username and password:

```bash
curl -X POST http://<host>:<port>/api/v1/repo/import
```

The repository build reads every uploaded file once and records it in the
repository database. Then it rewrites only the indexes the upload touched, and
writes and signs `InRelease`/`Release` or `repomd.xml` last, so clients never
see a partly written repository. For a status per file, use the MCP
`import_repository` tool.

Currently, the request is synchronous, so the response will come when the
build finishes. You can continue using the other APIs, even the file upload
API, while the repository build is in progress. The listings show each upload
as soon as the build has recorded it, while the repository indexes change only
when the build finishes. The file upload API might be delayed
slightly, though, because the first step of the repository build is to move
the uploaded files to the processing directory. During this move operation, the
upload API requests are delayed.

### Package Removal API

To remove a specific source package version from a published repository
— the source package and every binary package built from it — issue a
`DELETE` request against:

```
<scheme>://<host>:<port>/api/v1/repo/rpm/<distribution>/<release>/<source-package>/<version>
<scheme>://<host>:<port>/api/v1/repo/deb/<distribution>/<release>/<source-package>/<version>
```

For RPM, `<version>` is the source package's `<version>-<release>`, with or
without one trailing distribution tag (`.fc41`, `.el9`, `.el9_2`), so
`22-1.tpm1` matches `clevis-22-1.tpm1.fc41.src.rpm`. Binaries belong to the
source package named in their header, so they are removed with or without the
`.src.rpm`. For Debian, `<version>` is the source version, and the request
removes the source package, every binary built from it, and the `.changes` and
`.buildinfo` files of its uploads.

The `<format>`, `<distribution>`, `<release>`, and `<version>` path
segments each accept the single token `-` as a "match any" wildcard;
using `-` in the `<format>` position matches both `deb` and `rpm`. The
trailing `<version>` segment may also be omitted entirely, in which case
it is treated as `-` (match all versions). `<source-package>` stays
literal — a request can therefore sweep every release of a distribution,
every distribution, every version of a source package, or even every
configured format, but it cannot accidentally sweep across source
packages. Example:

```bash
# Remove clevis 21-1+tpm1u8+deb12 from every release of Debian:
curl -u "<username>:<password>" -X DELETE \
  "https://my-repo.example.com/api/v1/repo/deb/debian/-/clevis/21-1%2Btpm1u8%2Bdeb12"

# Remove every version of clevis from Fedora 41:
curl -u "<username>:<password>" -X DELETE \
  "https://my-repo.example.com/api/v1/repo/rpm/fedora/41/clevis/-"
```

`DELETE /api/v1/repo/-/-/-/<source>/-` removes the source from every configured `(format, distribution, release)` triple.

`DELETE /api/v1/repo/<format>/<distribution>/<release>/<source>` (no version segment) is shorthand for `DELETE /api/v1/repo/<format>/<distribution>/<release>/<source>/-`.

By default, the removed packages leave the repository indexes at once, but
their files stay downloadable for one day, so clients that fetched the previous
indexes can still download them. An hourly job then deletes them. Add
`?immediate=true` to delete the files right after the new `InRelease` or
`repomd.xml` is in place; clients still using the previous indexes may then get
`404` responses. `?immediate=false` is the default:

```bash
# Remove clevis 21-1+tpm1u8+deb12 from Debian Bookworm and delete its files at once:
curl -u "<username>:<password>" -X DELETE \
  "https://my-repo.example.com/api/v1/repo/deb/debian/bookworm/clevis/21-1%2Btpm1u8%2Bdeb12?immediate=true"
```

In both modes, a file still referenced by another release or version stays on
disk. It is reported with `status: "ok"`, because it left the indexes of the
matched releases.

The response mirrors the upload API shape:

```json
{
    "message": "Removed 1 file(s) across 1 release(s)",
    "files": [
        {
            "filename": "clevis-22-1.tpm1.fc41.src.rpm",
            "status": "ok",
            "path": "rpm/fedora/41/Packages/c/clevis/clevis-22-1.tpm1.fc41.src.rpm"
        }
    ]
}
```

Status codes:

* `200` — success, including the idempotent no-match case (returns an
  empty `files` array). Wildcards that expand to zero configured
  repositories also return 200.
* `400` — invalid characters in any path segment, or an `immediate` value
  other than `true` or `false`. The allowed set is
  `A-Z a-z 0-9 . + : ~ _ -`. Only the lone `-` is interpreted as a
  wildcard; any other token of allowed characters — including
  dash-prefixed or dash-containing ones like `-foo` or
  `bookworm-security` — is treated as a literal identifier.
* `404` — a **literal** `<distribution>` or `<release>` does not exist
  as a configured repository. Wildcards in the same position never
  produce 404.
* `500` — the removal failed, see the server logs. When an immediate
  removal could not delete some files, `files` still lists every entry,
  those files with `status: "failed"`; the hourly job deletes them later.

Remember to URL-encode reserved characters in Debian versions: `+` →
`%2B`, `~` → `%7E`, `:` → `%3A`. Example:

```bash
curl -u "<username>:<password>" -X DELETE \
  "https://my-repo.example.com/api/v1/repo/deb/debian/bookworm/clevis/21-1%2Btpm1u8%2Bdeb12"
```

### Package Listing API

To list the files belonging to a source package — the source package and
every binary package built from it — issue a `GET` request against:

```
<scheme>://<host>:<port>/api/v1/repo/rpm/<distribution>/<release>/<source-package>/<version>
<scheme>://<host>:<port>/api/v1/repo/deb/<distribution>/<release>/<source-package>/<version>
```

The path semantics mirror the [Package Removal API](#package-removal-api):
`<format>`, `<distribution>`, `<release>`, and `<version>` each accept the
single token `-` as a "match any" wildcard (using `-` in the `<format>`
position matches both `deb` and `rpm`), the trailing `<version>` segment
may be omitted entirely (treated as `-`), and `<source-package>` stays
literal. `GET /api/v1/repo/-/-/-/<source>/-` lists the source from every
configured `(format, distribution, release)` triple, and
`GET /api/v1/repo/<format>/<distribution>/<release>/<source>` (no version
segment) is shorthand for
`GET /api/v1/repo/<format>/<distribution>/<release>/<source>/-`.

The listing is paged. The `limit` query parameter sets the page size from 1 to
1000, the default is 1000. When more files follow, the response carries
`nextCursor`; pass it as the `cursor` query parameter to get the next page, and
omit `cursor` for the first one:

```bash
curl -u "<username>:<password>" \
  "https://my-repo.example.com/api/v1/repo/deb/debian/-/clevis?limit=100&cursor=<nextCursor>"
```

With paging, `touchedTargets` and the file count in `message` cover only the
current page.

The response body is:

```json
{
    "message": "Found 3 file(s) across 1 release(s)",
    "touchedTargets": 1,
    "files": [
        {
            "filename": "clevis_22-1+tpm1+deb12.dsc",
            "path": "deb/debian/pool/main/c/clevis/clevis_22-1+tpm1+deb12.dsc",
            "downloadUrl": "https://my-repo.example.com/deb/debian/pool/main/c/clevis/clevis_22-1+tpm1+deb12.dsc"
        }
    ]
}
```

For Debian, the response includes the `.changes` and `.buildinfo` files of the
uploads, when the pool has them. Packages imported without them keep missing
them — re-upload to backfill.

Each `downloadUrl` is an absolute URL pointing at the pool path and
can be fetched without authentication. `touchedTargets` counts the
`(format, distribution, release)` triples that contributed at least
one matching file.

Status codes:

* `200` — success, including the idempotent no-match case (returns an
  empty `files` array). Wildcards that expand to zero configured
  repositories also return 200.
* `400` — invalid characters in any path segment, or an invalid `limit` or
  `cursor`. The allowed set is the same as for the Package Removal API.
* `404` — a **literal** `<distribution>` or `<release>` does not exist
  as a configured repository. Wildcards in the same position never
  produce 404.

## MCP Server

Simple Repo Manager exposes a Model Context Protocol endpoint at `POST /api/v1/mcp` using the official Streamable HTTP transport. The endpoint is stateless (no session IDs, no resumable streams) and requires the same authentication as the rest of the `/api/v1/*` tree. Use the URL without a trailing slash: `/api/v1/mcp/` is always checked like an upload, even with `API_PUBLIC_READ`.

With `API_PUBLIC_READ=true` (see [Configuration Examples](#configuration-examples)), callers without credentials can connect too and get only the read tools: `server_status`, `list_repositories`, `list_source_packages` and `list_package_files`. The write tools `prepare_upload`, `import_repository` and `remove_package` appear only for requests that pass the IP allowlist and the credentials check.

### Identifying the instance

If you run more than one Simple Repo Manager — for example a home and a public mirror — set the optional `INSTANCE_LABEL` environment variable to a short human-readable label:

```dotenv
INSTANCE_LABEL=Home repository
```

When set, the label appears in the startup banner, as `serverInfo.title` in the MCP initialize response, and as a prefix in the MCP instructions string. This lets connected agents reliably distinguish deployments when a user says "do X on the home repository".

### Client configuration

Most agent CLIs ship a command to register an MCP server. In the examples
below, replace `<your-token>` with the bearer token configured on the
server in `API_BEARER_AUTH` — you can generate a 32-character random token
at https://1password.com/password-generator — and use the public URI of
your server (here, the same `https://my-repo.example.com` as in the rest
of the examples in this README).

For [Claude Code][claude-code]:

```bash
claude mcp add --transport http simple-repo-manager \
  https://my-repo.example.com/api/v1/mcp \
  --header "Authorization: Bearer <your-token>"
```

For [OpenAI Codex][codex], the `codex mcp add` command does not currently
expose a way to set arbitrary HTTP headers, so add the following entry to
`~/.codex/config.toml` directly:

```toml
[mcp_servers.simple-repo-manager]
transport = { type = "streamable_http", url = "https://my-repo.example.com/api/v1/mcp" }
http_headers = { Authorization = "Bearer <your-token>" }
```

For [Factory Droid][droid]:

```bash
droid mcp add simple-repo-manager \
  https://my-repo.example.com/api/v1/mcp \
  --type http \
  --header "Authorization: Bearer <your-token>"
```

[claude-code]: https://docs.claude.com/en/docs/claude-code

[codex]: https://developers.openai.com/codex/

[droid]: https://docs.factory.ai/

### Tools

| Tool | Access | Purpose |
|---|---|---|
| `server_status` | read | Report server health and the enabled formats. |
| `list_repositories` | read | Enumerate `(format, distribution, release)` triples, optionally filtered. |
| `list_source_packages` | read | List source packages across matching triples, paged. |
| `list_package_files` | read | List files belonging to a source package across matching triples, with per-file `downloadUrl` slots, paged. |
| `prepare_upload` | write | Return one PUT URL per filename. |
| `import_repository` | write | Import the staged uploads, with a status per file. |
| `remove_package` | write | Remove a package across matching triples; `immediate: true` deletes its files at once. |

The paged tools take an optional `limit` (1 to 1000) and `cursor`, the `nextCursor` of the previous result. As with the [Package Listing API](#package-listing-api), the counts in the result text cover only the current page. `remove_package` follows the [Package Removal API](#package-removal-api): without `immediate`, the files stay downloadable for one day.

### Upload flow

1. Agent calls `prepare_upload` with the target and filename(s). Response includes `slots[i].uploadUrl`.
2. Agent `PUT`s each file to its `uploadUrl` with the same `Authorization` header it used for MCP.
3. Agent calls `import_repository` to import the uploads.

## Configuration

The configuration is stored entirely in the environment variables. The
description and default values of the environment variables are listed in the
file [`env.example`][env-example]. You can use this file as a template for your
own configuration and load it into the environment by one of the methods
mentioned in the following sections.

### Docker Configuration

For Docker, make a copy of the [`env.example`][env-example] to `.env` file
(choose your name) and pass the path to the `docker run` command with
`--env-file .env` option:

```bash
docker run --detach \
  --name simple-repo-manager \
  --publish 80:3000 \
  --read-only --tmpfs /tmp \
  --env-file .env \
  --volume ./data:/app/data \
  simple-repo-manager
```

Alternatively, you can set the environment variables directly in the
`--env VARIABLE=value` option, or use the value from the current environment by
passing the shorter `--env VARIABLE` form:

```bash
docker run --detach \
  --name simple-repo-manager \
  --publish 80:3000 \
  --read-only --tmpfs /tmp \
  --env UPLOAD_FIELD_NAME=file \
  --volume ./data:/app/data \
  simple-repo-manager
```

> [!NOTE]
> When configuring HTTPS server (see
> [Configuration Examples](#configuration-examples)), replace the exposed port
> number 80 by port 443 in the `ports` element. Alternative to running HTTPS
> server is using an SSL-terminating reverse proxy.

### Docker Compose Configuration

For Docker Compose, copy the [`env.example`][env-example] file to `.env` in the
same directory as the `compose.yml` file. The Docker Compose will load it
automatically. You can also use the `env_file` element in the `compose.yml` file
to specify the path to the `.env` file (and choose a different file name), or
use the `environment` element to set the environment variables directly. It is
also possible to set the environment variables by overriding the `env_file`
and/or `environment` elements in the `compose.override.yml` file, which is
loaded automatically by Docker Compose.

For the simple `compose.yml` file:

```yaml
services:
  simple-repo-manager:
    image: simple-repo-manager
    read_only: true
    tmpfs:
      - /tmp
    volumes:
      - type: bind
        source: ./data
        target: /app/data
        bind:
          create_host_path: false
    ports:
      - "127.0.0.1:80:3000"
      - "[::1]:80:3000"
```

you can override the environment variables in the `.env` file:

```dotenv
UPLOAD_FIELD_NAME=file
```

or directly in the `compose.yml` file, or in the `compose.override.yml` file as
in the following example:

```yaml
services:
  simple-repo-manager:
    environment:
      UPLOAD_FIELD_NAME: file
```

> [!NOTE]
> When configuring HTTPS server (see
> [Configuration Examples](#configuration-examples)), replace the exposed port
> number 80 by port 443 in the `ports` element. Alternative to running HTTPS
> server is using an SSL-terminating reverse proxy.

### Local Development Configuration

For local development, the most convenient way is to benefit from the
[`dotenv`][dotenv] package, which is already a dependency of the project. You
can use it by creating a file named `.env` in the root of the project directory
with the content of [`env.example`][env-example] file and then start the
application.

To change the environment file path, you can specify the path in the
`DOTENV_CONFIG_PATH` environment variable. To prevent loading `.env` file
entirely, you can set the `DOTENV_CONFIG_PATH` environment variable to
`/dev/null`.

[env-example]: https://github.com/oldium/simple-repo-manager/blob/master/env.example

[dotenv]: https://www.npmjs.com/package/dotenv

### Configuration Examples

Please consult the [`env.example`][env-example] file for the full list of
environment variables. The following examples show how to configure the
application using the environment variables for specific use cases.

HTTPS server running on port 443 (default HTTPS port) with certificates located
in the current directory in `certs/key.pem` and `certs/cert.pem` files:

```dotenv
HTTP_PORT=443
HTTPS_KEY_FILE=certs/key.pem
HTTPS_CERT_FILE=certs/cert.pem
```

Public URL `https://repo.example.com` for the absolute URLs in the installation
instructions and in the API responses. Without it, the URLs are built from the
`Host` header sent by the client, which anybody can forge. `X-Forwarded-*`
headers from trusted proxies (see `TRUST_PROXY`) still override it:

```dotenv
PUBLIC_URL=https://repo.example.com
```

The `/api/v1/*` API (uploads, repository management, removal, MCP) is
protected by a stack of IP allowlisting plus HTTP Basic or Bearer
authentication, configured through the following environment variables:

| Variable | Purpose | Format |
|---|---|---|
| `API_ALLOWED_IPS` | IP allowlist applied to all `/api/v1/*` routes | `proxy-addr` syntax (comma-separated) |
| `API_BASIC_AUTH` | HTTP Basic credentials | JSON-ish object `{user: password, ...}` |
| `API_BEARER_AUTH` | HTTP Bearer tokens | JSON-ish array `[token1, token2]` or comma-separated |
| `API_PUBLIC_READ` | Read requests skip the IP allowlist and the credentials | `true` or `1` |

Legacy `UPLOAD_ALLOWED_IPS` / `UPLOAD_BASIC_AUTH` are still accepted but log a deprecation warning at startup; please migrate to the `API_*` names.

API reads open to everybody — `GET /api/v1/status`, the
[Package Listing API](#package-listing-api) and the MCP read tools — while
uploads, imports, removals and the MCP write tools keep the IP allowlist and
the credentials. Wrong credentials still get `401`, even for reads. Downloads
and the repository browser are public anyway:

```dotenv
API_PUBLIC_READ=true
```

API limited to only local accesses going through the reverse proxy
running on server 10.1.2.1 and filling `X-Forwarded-For` header:

```dotenv
TRUST_PROXY=10.1.2.1
API_ALLOWED_IPS=loopback,10.1.2.0/24
```

API protected by basic authentication with username `rico` and password
`kaboom`, and username `kowalski` and password `candy-canes`:

```dotenv
API_BASIC_AUTH=rico:kaboom, kowalski:candy-canes
```

API protected by a bearer token (for example, generated at
https://1password.com/password-generator and used by the MCP client):

```dotenv
API_BEARER_AUTH=s3cret-token-abcdef0123456789
```

Use different field for POST uploads, e.g. `file`:

```dotenv
UPLOAD_FIELD_NAME=file
```

Use different directories for data, e.g. `/data/incoming`, `/data/repo` and
`/data/repo-state`:

```dotenv
INCOMING_DIR=/data/incoming
REPO_DIR=/data/repo
REPO_STATE_DIR=/data/repo-state
```

Use GPG private key `repo-key.asc` (ASCII-armored format or binary format,
extension does not matter) located in the current directory for signing the
repository metadata, see
[Signing Repository Metadata](#signing-repository-metadata) for the key
requirements:

```dotenv
GPG_REPO_PRIVATE_KEY_FILE=repo-key.asc
```

Define `Origin:` and `Description:` tags separately for the Debian and Ubuntu
distributions metadata:

```dotenv
DEB_ORIGIN_DEBIAN=My Debian Repository
DEB_DESCRIPTION_DEBIAN=My Debian Repository for Debian distributions
DEB_ORIGIN_UBUNTU=My Ubuntu Repository
DEB_DESCRIPTION_UBUNTU=My Ubuntu Repository for Ubuntu distributions
```

### Installation Instructions HTML Templates

The installation instructions are shown on every page and are rendered by HTML
template engine [η (eta)][eta-sources], please consult the eta
[documentation][eta-documentation] for more details on the templating engine.
Also, please check [`env.example`][env-example] file for the description of
`TEMPLATES_DIR` environment variable for the possibility to define custom
templates, the details on available template variables and how to override them.

> [!NOTE]
> The templates are cached, so to test changes, you need to restart the
> application.

Brief overview of the templating engine functions:

* `<%` `%>` - execute JavaScript block
* `<%=` `%>` - evaluate JavaScript expression and escape the result for
  inclusion in HTML
* `<%~` `%>` - evaluate JavaScript expression and output it verbatim

The opening and closing tags can contain white-space stripping flags:

* `<%-` - strip one leading newline
* `<%_` - strip all leading whitespaces
* `-%>` - strip one trailing newline
* `_%>` - strip all trailing whitespaces

The opening tags can be combined with the function, like `<%- =` (space is
optional) to evaluate JavaScript expression.

Inclusion of other templates:

* `<%~ include('template') %>` - include another template by name
  (defined environment variable `TEMPLATES_DIR` is required for this
  functionality)
* `<%~ include('@default-deb') %>` - include built-in Debian installation
  instructions template
* `<%~ include('@default-rpm') %>` - include built-in RedHat installation
  instructions template
* `<%~ include('@default-rpm', {repoName: "My RPM Repository"}) %>` - evaluate
  built-in RedHat repository installation instructions template, but override
  the `repoName` value

For particular usage of the templating tags please consult the default templates
in the [`templates`][templates] source code directory.

Example of the template for the installation instructions for OpenSUSE and SUSE
Linux Enterprise Server (SLES) distributions with upload `<distribution>` name
used as simply `suse` could be:

*`templates/rpm-suse.eta.html`*:

```html
<% if (gpgUri) { -%>
<pre>sudo mkdir -p <%= gpgKeyDir %> && \
sudo curl -fsSL <%= gpgUri %> -o <%= gpgKeyDir %>/<%= gpgKeyFile %></pre>
<% } -%>
<pre>sudo tee /etc/zypp/repos.d/<%= repoDashSlug %>.repo >/dev/null <<'EOF'
[<%= repoDashSlug %>]
name=<%= repoName %>
baseurl=<%= releaseUri %>
enabled=1
autorefresh=1
<% if (gpgUri) { -%>
gpgcheck=1
pkg_gpgcheck=1
gpgkey=file://<%= gpgKeyDir %>/<%= gpgKeyFile %>
<% } -%>
EOF
</pre>
<pre>sudo rpm --import <%= gpgKeyDir %>/<%= gpgKeyFile %> && \
sudo zypper refresh <%= repoDashSlug %>
</pre>
```

To activate the template for all SUSE distributions, you need to set the
`TEMPLATES_DIR` environment variable to the directory containing the template
file:

```dotenv
RPM_DISTRO_NAME_SUSE=SUSE
TEMPLATES_DIR=templates
```

The `RPM_DISTO_NAME_SUSE` environment variable is set to make the name shown on
the web UI as SUSE instead of the default capitalized Suse.

When using Docker, propagate the `templates` directory to the container:

* Docker: Add `--volume ./templates:/app/templates:ro` command-line argument.
* Docker Compose: Add the following to the service definition or the override
  definition:

  ```yaml
  services:
    simple-repo-manager:
      volumes:
        - type: bind
          source: ./templates
          target: /app/templates
          read_only: true
          bind:
            create_host_path: false
  ```

The templates must be readable by the user the container runs as, see
[Docker Build](#docker-build).

And, as a last step, restart the application to apply the new configuration.

[eta-sources]: https://github.com/bgub/eta

[eta-documentation]: https://eta.js.org/

[templates]: https://github.com/oldium/simple-repo-manager/tree/master/templates

### Signing Repository Metadata

The repository metadata can be signed using a GPG key. The server signs it
itself with [OpenPGP.js][openpgpjs] and a SHA-256 hash. The signing key is not
generated and needs to be provided by the administrator. The best practice is
to use the same GPG private key used for signing the packages, so the
repository metadata is signed with the same key as the packages themselves. The
private key can be provided in the `GPG_REPO_PRIVATE_KEY_FILE` environment
variable, which can point to either an ASCII-armored file (usually with `.asc`
extension) or a binary file (usually with `.gpg` extension).

The key must be usable by OpenPGP.js: an RSA key of at least 2048 bits or an
ECC key (like Ed25519), not protected by a passphrase. Otherwise, the server
refuses to start. When the configured key file does not exist, the server logs a
warning and keeps the existing signatures until an import or removal republishes
the release, which leaves it unsigned. Without `GPG_REPO_PRIVATE_KEY_FILE`, the
metadata is not signed.

The server signs with the key as provided and logs its algorithm and fingerprint
at the start. Choose an algorithm the clients of your repositories can verify,
as newer ones may not work on older distributions. For example, Debian Bullseye,
Ubuntu Noble and CentOS Stream 9 cannot verify algorithm 27 (RFC 9580 Ed25519).

[openpgpjs]: https://openpgpjs.org/

> [!IMPORTANT]
> Please note that the Repository Management API does not sign the uploaded
> packages; it only signs the metadata. The uploader must sign the packages
> themselves before uploading them to the repository.

When using Docker, bind-mount the key file read-only and point the environment
variable to it:

* Docker: Add `--volume ./repo-key.asc:/app/repo-key.asc:ro` and
  `--env GPG_REPO_PRIVATE_KEY_FILE=/app/repo-key.asc` command-line arguments.
* Docker Compose: Add the following to the service definition or the override
  definition:

  ```yaml
  services:
    simple-repo-manager:
      volumes:
        - ./repo-key.asc:/app/repo-key.asc:ro
      environment:
        GPG_REPO_PRIVATE_KEY_FILE: /app/repo-key.asc
  ```

The key file must be readable by the user the container runs as, see
[Docker Build](#docker-build).

The public key is extracted automatically during server start-up from the
private key and is _added_ as an ASCII-armored key to the repository files
`<REPO_DIR>/deb/archive-keyring.asc` and `<REPO_DIR>/rpm/RPM-GPG-KEY.asc`, which
correspond to the following URIs:

```url
<scheme>://<host>:<port>/deb/archive-keyring.asc
<scheme>://<host>:<port>/rpm/RPM-GPG-KEY.asc
```

If the public key file already exists, it is parsed, and if the public key is
not found there, the new public key is added to the top of the file. The public
keys are not merged, so they can be found easily. Nothing is ever removed from
the file, so if some public keys need to be removed, that must be done manually.

> [!IMPORTANT]
> Any manual changes to the repository public key files need to preserve the
> ASCII-armored format.

If the packages are signed with a different key not available in the system
keyring, the corresponding public key can either be manually added to the
repository keyring files or supplied to the user differently. For example, by
providing a native package with the public keys and signed with the repository
private key.

Signing the Debian-like repository metadata results in the following files in
every release:

* `Release` file containing the metadata for the repository.
* `Release.gpg` file containing the GPG signature of the `Release` file.
* `InRelease` file containing the metadata for the repository in ASCII-armored
  format and signed by the GPG key.

Signing the RedHat-like repository metadata results in the following files in
every release:

* `repodata/repomd.xml` file containing the metadata for the repository.
* `repodata/repomd.xml.asc` file containing the GPG signature of the
  `repodata/repomd.xml` file.

### Package Signatures

The repository manager does not sign the uploaded packages, it only signs the
repository metadata. The uploader must sign the packages themselves.

## Production Build

The recommended way to run the Simple Repository Manager in production is to use
Docker. The project provides a `Dockerfile` file to build the Docker image. See
below for details on how to build and run the Docker image.

### Manual Build

To build the production version of the application, run:

```bash
npm run build
```

This will create a production build in the `dist` directory. The application can
then be started with:

```bash
npm run prod
```

This `dist` directory is not self-contained, it needs `node_modules` in order to
run. So to create the smallest runnable application, you need to copy the
`dist` directory, as well as the `package.json` and `package-lock.json` files
to the target directory (the example uses `/app` directory, use any target
directory you like) and prepare the `node_modules` directory with the following
commands:

```bash
mkdir -p /app/dist
cp --recursive dist/ package.json package-lock.json /app/
cd /app
npm ci --omit=dev
```

The resulting target directory now contains the production build of the
application, which can be run with:

```bash
cd /app
NODE_ENV=production \
  node --enable-source-maps ./dist/server.js
```

> [!NOTE]
> The `--enable-source-maps` option is used to enable source maps for debugging
> the production build. It is not required, but it is recommended for easier
> finding the location of the code in the source files.

The configuration (see [Configuration](#configuration) section for details) can
be supplied by environment variables set in the `.env` file located in the
target directory. It will be automatically loaded by the application when it
starts. Alternatively, you can set the environment variables directly in the
environment before starting the application.

To prevent loading `.env` file in the production, you can set the
`DOTENV_CONFIG_PATH` environment variable to `/dev/null` or any non-existing
file.

### Docker Build

The image is based on [Docker Hardened Images][dhi] for Node.js, which are
pulled from the `dhi.io` registry. The registry requires signing in with a
Docker account, a free one is sufficient:

```bash
docker login dhi.io
```

To build the Docker image, run the following command in the root of the project
directory:

```bash
docker build -t simple-repo-manager .
```

This will create a Docker image with the name `simple-repo-manager`. The image
is self-contained and can be used to run the application in production, the
server needs nothing but Node.js. For troubleshooting, the image also contains
`bash`, [BusyBox][busybox] with the standard tools like `ls`, `find`, `grep`,
`less`, `vi`, `tar` or `ps`, and `zstd` and `rpm2cpio` to inspect packages (see
[Troubleshooting](#repository-management-api-call-failed)), but no package
manager.

[busybox]: https://busybox.net/

[dhi]: https://docs.docker.com/dhi/

> [!NOTE]
> The author of Simple Repo Manager creates the release builds with the
> following command, which ensures that fresh third-party images are used and
> adds additional metadata to the Docker image itself:
>
> ```bash
> docker buildx build --progress=plain --attest type=provenance,mode=max \
>   --attest type=sbom,generator=docker/scout-sbom-indexer:latest \
>   --no-cache -f .\Dockerfile . -t simple-repo-manager
> ```

The Docker image exposes the port `3000` and by default expected the data
directory to be mounted to `/app/data` in the container. The data directory
contains the repository data, so it needs to be persistent. To run the Docker
image on port 80 and use local directory `data` for persistent repository
storage, you can use the following command:

```bash
docker run --detach \
  --name simple-repo-manager \
  --publish 80:3000 \
  --read-only --tmpfs /tmp \
  --volume ./data:/app/data \
  simple-repo-manager
```

The application writes only to `/app/data`, the rest of the image is owned by
`root`. The container can therefore run with a read-only root filesystem, with
`/tmp` as a tmpfs scratch space for troubleshooting. The image
already contains [tini][tini] as the init process, so the `--init` option is not
needed.

By default, the application runs as user `node` with UID/GID `1000:1000`. Use
the `--user` option to run it as a different user, for example as your own user:

```bash
docker run --detach \
  --name simple-repo-manager \
  --publish 80:3000 \
  --read-only --tmpfs /tmp \
  --user "$(id -u):$(id -g)" \
  --volume ./data:/app/data \
  simple-repo-manager
```

The data directory must be writable and the mounted files, like the GPG keys or
templates, must be readable by the user the container runs as. Mount the files
read-only with the `:ro` suffix, the application does not change them. The
`/app/data` directory in the image is owned by the default user `1000:1000`, and
a new named volume takes over its owner and permissions. A bind-mounted host
directory keeps its owner, so prepare it before the first start:

```bash
mkdir -p data
sudo chown 1000:1000 data
```

When running as a different user, change the owner to that user and use a
bind-mounted directory, because a new named volume would be owned by
`1000:1000`. When the application cannot access the data directories or the
mounted files at start-up, it stops and logs their owner and mode.

[tini]: https://github.com/krallin/tini

See the [Configuration](#configuration) section for details on how to configure
the Docker environment.

### Docker Compose

Feel free to use the provided `compose.yml` file as a basis to run the Docker
image with Docker Compose on production. The file contains the same
configuration as the `docker run` command above, but it is more convenient to
use. You can start the Docker container with the following command:

```bash
docker compose up --detach
```

The provided `compose.yml` compiles the Docker image from the sources. You will
probably want to replace the `build` element by specifying the particular image
name, e.g. `image: simple-repo-manager`, with the name of the pre-built Docker
image for use in production.

The bind-mounted `./data` directory must exist before the start and must be
writable by the user the container runs as, see [Docker Build](#docker-build).
With `create_host_path: false`, Docker Compose does not create a missing
directory owned by root, which the application could not write to. The start
fails with `bind source path does not exist` instead.

To run the application as a different user, add the `user` attribute to the
service and make `./data` owned by that user instead:

```yaml
services:
  simple-repo-manager:
    user: "1001:1001"
```

See the [Configuration](#configuration) section for details on how to configure
the Docker Compose environment.

## Repository Database

The repository state lives in the SQLite database `repo.db` in the
`REPO_STATE_DIR` directory (`data/repo-state/repo.db` by default), and the
published repositories in `REPO_DIR` are generated from it. Back up both
directories together with the server stopped, because the database keeps its
latest changes in a write-ahead log next to it. To inspect the database, open
it read-only with the
`sqlite3` tool, which the devcontainer provides (the Docker image does not):

```bash
sqlite3 -readonly data/repo-state/repo.db .tables
```

### Rebuilding the Repository Database

The server can rebuild the database from the published repositories. It does so
automatically at the first start when the database is missing and `REPO_DIR`
already contains a `deb` or `rpm` directory, and on request with the
`--rebuild` command-line argument:

```bash
npm run prod -- --rebuild
```

With Docker, stop the running container and run the image once in the
foreground with the argument. Pass the same environment and volumes as to the
regular container, including the signing key, otherwise the rebuild publishes
unsigned metadata. The server keeps serving after the rebuild, so stop it with
Ctrl+C and start the regular container again:

```bash
docker stop simple-repo-manager
docker run --rm -it --env-file .env --volume ./data:/app/data \
  simple-repo-manager node --enable-source-maps ./dist/server.js --rebuild
docker start simple-repo-manager
```

With Docker Compose, the one-off run takes the service configuration:

```bash
docker compose stop
docker compose run --rm simple-repo-manager node --enable-source-maps ./dist/server.js --rebuild
docker compose up --detach
```

The rebuild runs before the server starts serving. It reads the published
indexes of every Debian-like release and checks every package file against
them, and it reads every `.rpm` of every RedHat-like release. Any problem, like
an unreadable package, a checksum mismatch or a missing file, aborts the
rebuild: nothing on disk changes, the server logs every problem found and
refuses to start. Otherwise, the RPMs move to the
`Packages/<first character>/<source name>/` layout, every release is published
again, and the new database replaces the old one. Index files that are no
longer needed are deleted after one day. A release without packages stays
published, with empty indexes.

The published tree does not record removals that are still waiting for the
garbage collection, so a rebuild during that day has two limits:

* A removed RPM whose file is still there comes back, the rebuild reads every
  `.rpm`. Remove it again.
* The pool files of a removed Debian package stay on disk, referenced by
  nothing. The rebuild logs them and leaves them in place, and nothing deletes
  them later.

### Migrating from 2.x

Version 2.x built the repositories with `reprepro` and `createrepo_c` and
signed them with `rnp`, with `gpg` checking signed uploads. None of them is
needed any more: the first start of the new version migrates the published
repositories once, with the [rebuild](#rebuilding-the-repository-database)
described above. Back up the `data` directory before that start, and keep the
backup until the migration is verified.

* The repository URLs and the installation instructions stay the same. RPMs
  move from `Packages/<first character>/` to
  `Packages/<first character>/<source name>/` in lower case, clients pick up the
  new paths with their next metadata refresh.
* Debian-like releases publish only compressed indexes, with `by-hash` copies.
  The uncompressed `Packages` and `Sources` files and the per-component
  `Release` files are gone.
* The `reprepro` state in `REPO_STATE_DIR/deb-<distribution>/` is no longer
  used and can be deleted after a successful migration. Staged uploads keep
  working.
* `REPREPRO_BIN`, `CREATEREPO_SCRIPT`, `GPG_BIN`, `SIGN_SCRIPT`,
  `GPG_PUBLIC_KEYS_FILE`, `GPG_PUBLIC_KEYS_DIR` and `GNUPGHOME` are no longer
  used, and the server logs a warning when they are set. Signed `.changes`
  files are no longer verified, uploads are protected by the API
  authentication only.
* The signing key must be usable by OpenPGP.js, see
  [Signing Repository Metadata](#signing-repository-metadata).

## Troubleshooting

### Repository Management API Call Failed

If an import or a removal fails, consult the server logs. A failed file in the
MCP `import_repository` result carries a reason with a correlation id, like
`import failed, correlation id=<id>: <cause>`, and the log lines of the failure
carry the same id. The cause is shown for invalid uploads only, like missing
files or a release not listed in `Distribution:`. The files of a failed import
wait in `INCOMING_DIR`, and every later import retries them, so fix the cause,
upload the missing files if needed, and call the import again.

If you run the application in Docker, you can view the logs with the following
command:

```bash
docker logs simple-repo-manager
```

or in the case of the Docker Compose:

```bash
docker compose logs simple-repo-manager
```

You can then enter the Docker container to inspect the files with the
following command:

```bash
docker exec -it simple-repo-manager bash
```

or in the case of the Docker Compose:

```bash
docker compose exec simple-repo-manager bash
```

The packages can be inspected with the BusyBox tools, which cannot decompress
zstd used by Ubuntu, Fedora and Enterprise Linux 9 packages, so pipe them
through `zstd` or use `rpm2cpio`. Extract the files to the writable `/tmp`:

```bash
ar t package.deb
ar p package.deb control.tar.zst | zstd -dc | tar -xO ./control
ar p package.deb data.tar.zst | zstd -dc | tar -t
rpm -qpi package.rpm
rpm -qpl package.rpm
cd /tmp && rpm2cpio package.rpm | cpio -idm
```

For packages with `.xz` members, replace `zstd -dc` with `xz -dc`.

If you have the persistent storage mounted as a host directory into the
container, you can benefit from using the local tools instead of inspecting the
files in the container directly.

The shell runs as the same user as the application.

> [!IMPORTANT]
> Do not enter the container as `root` (`-u root`) to test anything. Files
> created by `root` inside the `INCOMING_DIR`, `REPO_DIR` or `REPO_STATE_DIR`
> are not accessible by the application, and nothing fixes their ownership
> automatically.

### Uploading and Re-uploading Debian Packages

The server acts as a simple indexer: any package version can be uploaded, and
every uploaded version stays visible in the repository index. In practice this
means `apt install pkg=<version>` works for any version that has been uploaded
to the release, and an older version can still be published after a newer one
exists.

Uploading the same source version to the same release again (common during
development when a package is rebuilt without bumping the version) replaces the
previous upload of that version, but only for the architectures the new
`.changes` file lists in its `Architecture:` field:

* `source` replaces the source package (`.dsc` and tarballs).
* `all` or a concrete architecture like `amd64` replaces only the binaries of
  that architecture. A binary-only upload for `arm64` therefore adds `arm64`
  next to the existing `amd64` binaries and the source.

A file with the same name and different content is overwritten. The import
fails when another release or version still references the old content, for
example an upstream tarball shared with another release; remove the package
from that release first. Files the new upload no longer contains stay
downloadable for one day, as with the
[Package Removal API](#package-removal-api).

### Removing Packages from the Repository

Use the [Package Removal API](#package-removal-api) to remove a source
package and every binary built from it from a published repository. It
supports both Debian-like and RedHat-like repositories with a symmetric
URL shape.

Do not delete or change files in the published repositories manually, the
server keeps listing them in the indexes it generates from the
[repository database](#repository-database).

### Regenerate Metadata Signatures

At every start, the server checks the signatures of every release against the
configured key and signs again the releases whose signatures do not match. So
after changing `GPG_REPO_PRIVATE_KEY_FILE`, a restart is enough. Changed
`DEB_ORIGIN*` and `DEB_DESCRIPTION*` values also update the affected `Release`
files at the start.

## About the Project

### Why?

There are some OpenSource alternatives like [OpenRepo][openrepo] or
[Pulp][pulp]. However, the former one has not seen release since 2022 and for
the latter one you need to create multiple scripts to make it work
(including patching the embedded Nginx configuration to run behind the
SSL-terminating Nginx reverse proxy).

So I decided to create a simple repository manager, which does only the basics
(package uploads, signing the repository metadata). It builds the repository
indexes itself and rewrites only the parts an upload or removal changes.

When used with Docker, the project is self-contained, so it does not require any
external Nginx reverse proxy but can run behind it as well.

[openrepo]: https://github.com/openkilt/openrepo

[pulp]: https://www.pulpproject.org/
