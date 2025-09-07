# Simple Repository Manager

This is a [Node.js][nodejs] project providing a simple repository manager for
Debian and RedHat repository formats. It has a little logic, it is able to
receive uploaded files by POST and PUT HTTP methods and uses third-party tools
to organize the uploads into a repository structure.

Features:

* 🚀 File upload by POST HTTP method.
* 🚀 File upload by PUT HTTP method compatible with Debian's `dput` and
  `dput-ng` tools.
* ✒️ Supports building a signed repository.
* 📦 Uses Debian's `reprepro` tool for repository management. Automatically
  maintains the `reprepro` configuration.
* 📦 Uses RedHat's `createrepo_c` tool for repository management.
* ✂️ Separates distributions (Debian vs. Ubuntu) and for RedHat-like
  repositories also releases (Fedora 41 vs. 42).
* 🎨 Supports multiple distributions and releases.
* 📂 Self-contained, serves the created repositories, a separate Nginx instance
  is not necessary.
* 🌓 Dark mode is supported 😉.

The project follows a minimal approach — upload the file and call the tool to do
the rest. If you need to do any change, do it manually in the repository and
call the tools to synchronize the repository metadata. Please be aware that
`reprepro` configuration files are parsed and generated again every time, so
manual changes might be lost, see details [below](#repository-management-api).

[nodejs]: https://nodejs.org

## Quick Start

This project was developed and tested with [Node.js][nodejs] version 24. The
project requires the following software to be fully operational (but starts
without them as well):

* 🎩 [createrepo_c][createrepo_c] version 1.2.0 or higher, older versions have
  not been tested. Required for RedHat-like repositories.
* 🎩🌀 [rnp][rnp] version 0.16.3 or higher, older versions have not been tested.
  Optional, but required for signing repository metadata.
* 🌀 [reprepro][reprepro] version 5.4.7 or higher, older versions do not support
  `ddeb` files. Required for Debian-like repositories.
* 🌀 [gpg][gpg] version 2.2.40 or higher, older versions have not been tested.
  Optional, but required by `reprepro` tool for verifying signed Debian
  packages.

> [!NOTE]
> All software packages are available in Debian Trixie, but unfortunately
> not the recent versions. Due to a [bug][reprepro-bug] in `reprepro` the latest
> version is 5.3.2, but that version does not support `ddeb` files. The
> Dockerfile contains recipe to build and install `reprepro` package for Debian
> Trixie from sources taken from Debian Experimental release.

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

The Development Container (devcontainer in short) has all the dependencies
installed, including `createrepo_c` and `reprepro`, so you can test the server
without installing them on your local machine. Please consult the relevant
documentation for your IDE, like [Visual Studio Code][vscode-devcontainer] or
[JetBrains WebStorm][jetbrains-devcontainer], to learn how to run the
Development Containers.

You can also run the production version based on the `Dockerfile` with all the
required software with Docker Compose:

```bash
docker compose up --detach
```

This will build the local Docker image (from `Dockerfile`) and start local
server listening at http://localhost (port 80 is forwarded to container port
3000\) with local folder `./data` mounted to `/app/data` in the container.

[createrepo_c]: https://github.com/rpm-software-management/createrepo_c

[reprepro]: https://salsa.debian.org/debian/reprepro

[rnp]: https://www.rnpgp.org/software/rnp/

[gpg]: https://www.gnupg.org/

[reprepro-bug]: https://bugs.debian.org/cgi-bin/bugreport.cgi?bug=1095493

[vscode-devcontainer]: https://code.visualstudio.com/docs/devcontainers/containers

[jetbrains-devcontainer]: https://www.jetbrains.com/help/webstorm/dev-containers-starting-page.html

## Usage

To use the repository manager, you need to follow these steps:

* Configure the server. See the [Configuration](#configuration) section below
  for details.
* Start the server. See the [Quick Start](#quick-start) section above for
  details.
* Upload the packages to the repository. See the [Upload API](#upload-api)
  section below for details.
* Build the repository. See the
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
echo <<<EOM
Types: deb
URIs: <scheme>://<host>:<port>/deb/<distribution>/
Suites: <release>
Components: <component>
Signed-By: /etc/apt/trusted.gpg.d/my-repo.gpg
EOM | sudo tee /etc/apt/sources.list.d/my-repo.list
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
echo <<<EOM
Types: deb
URIs: https://my-repo.example.com/deb/debian/
Suites: bookworm
Components: main
Signed-By: /etc/apt/trusted.gpg.d/my-repo.gpg
EOM | sudo tee /etc/apt/sources.list.d/my-repo.list
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
curl -fsSL <scheme>://<host>:<port>/rpm/RPM-GPG-KEY.asc | 
  sudo gpg --dearmor -o /etc/pki/rpm-gpg/RPM-GPG-KEY-my-repo
```

Then add the repository to the YUM/DNF configuration:

```bash
echo <<<EOM
[rpm-my-repo]
name=My Repository
baseurl=<scheme>://<host>:<port>/rpm/<distribution>/<release>/
enabled=1
gpgcheck=1
repo_gpgcheck=1
gpgkey=file:///etc/pki/rpm-gpg/RPM-GPG-KEY-my-repo
EOM | sudo tee /etc/yum.repos.d/my-repo.repo
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
curl -fsSL https://my-repo.example.com/rpm/RPM-GPG-KEY.asc | sudo gpg --dearmor -o /etc/pki/rpm-gpg/RPM-GPG-KEY-my-repo
```

```bash
echo <<<EOM
[rpm-my-repo]
name=My Repository
baseurl=https://my-repo.example.com/rpm/fedora/41/
enabled=1
gpgcheck=1
gogpkey=file:///etc/pki/rpm-gpg/RPM-GPG-KEY-my-repo
EOM | sudo tee /etc/yum.repos.d/my-repo.repo
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

## Upload API

The upload API is designed to be used by tools like `dput`, `dput-ng` and
`curl`. It can be optionally protected by basic authentication. See the
[Configuration](#configuration) section for more details.

The response to all the Upload API requests below the `/upload` path is always
JSON with the following fields:

* `message`: A human-readable message describing the result of the upload.
* `files`: Optional array of uploaded files. Each entry contains the following
  fields:
  * `filename`: The name of the uploaded file.
  * `status`: The upload status, which can be `"ok"` or `"failed"`.
  * `path`: Optional path of the uploaded file without the `/upload` prefix.
* `api`: Only present for the [Upload Status API](#upload-status-api) request.
* `correlation`: Optional unique identifier with the `id` field, which can be
  used to track the request in the server logs. Present only for HTTP response
  error status codes `400` and higher.

### Upload Status API

The status API is available at the `/upload/status` endpoint. It serves as a
confirmation that the authentication is correctly set up because the same rules
apply as for the other upload APIs. The status response contains the following
fields:

* `message`: A message that the server is up and running.
* `api`: Dictionary with the following structure:
  * `deb`:
    * `enabled`: A boolean indicating that the Debian-like Upload API is
      correctly configured and enabled.
  * `rpm`:
    * `enabled`: A boolean indicating that the RedHat-like Upload API is
      correctly configured and enabled.

### Debian Upload API

> [!NOTE]
> The Debian Upload API is compatible with `dput` and `dput-ng` tools and can
> be used for uploading Debian-based distributions like Debian, Ubuntu, etc.

The Repository Management API (the `reprepro` tool) expects that all files have
been uploaded already. This means that the client must upload the
`<package>.changes` file and all files listed in the `<package>.changes` file.
For example, upload of the first packaged version of fictitious package `foo`
version `1.0` would require the following files (the full list of files varies
based on the source package and distribution):

* `foo_1.0-1_amd64.changes`
* `foo_1.0-1_amd64.dsc`
* `foo_1.0-1_amd64.deb`
* `foo-dbgsym_1.0-1_amd64.deb` or `foo-dbgsym_1.0-1_amd64.ddeb`
* `foo_1.0-1_amd64.buildinfo`
* `foo_1.0.orig.tar.gz`
* `foo_1.0-1.debian.tar.xz`

The `buildinfo` file is required only because it is part of the `changes` file,
but it will not be stored within the repository. All other files (built package,
source package, debug symbols) are stored in the repository.

> [!IMPORTANT]
> The `<distribution>` component in the URIs must match the `Distribution:` tag
> of the `<package>.changes` file.

#### POST API

* `/upload/deb/<distribution>/<release>/<component>`
* `/upload/deb/<distribution>/<release>/<component>/<sub-component>`

The POST API expects a `multipart/form-data` request with the field `package`
(can be changed, see [Configuration](#configuration) section) containing the
uploaded files. In case of multiple files in the same request, the field name
must be `package` without any additional brackets. The `curl` tool can be used
to upload the files with the following command:

```bash
curl -u "<username>:<password>" \
  -F "package=@foo_1.0-1_amd64.changes" \
  -F "package=@foo_1.0-1_amd64.dsc" \
  -F "package=@foo_1.0-1_amd64.deb" \
  -F "package=@foo-dbgsym_1.0-1_amd64.deb" \
  -F "package=@foo_1.0-1_amd64.buildinfo" \
  -F "package=@foo_1.0.orig.tar.gz" \
  -F "package=@foo_1.0-1.debian.tar.xz" \
  https://<host>:<port>/upload/deb/<distribution>/<release>/<component>
```

For example, to upload the package to Debian Bookworm distribution into
component `main`, the URI would look like:

```url
https://my-repo.example.com/upload/deb/debian/bookworm/main`
```

To upload the file to the Debian Bookworm security update distribution and
component `updates/main`, one could use:

```url
https://my-repo.example.com/upload/deb/debian/bookworm-security/updates/main`
```

For **testing** with plain HTTP and disabled authorization one could use
`http` instead of `https` and omit the `-u` argument with the username and
password:

```bash
curl -F "package=@foo_1.0-1_amd64.changes" \
  -F "package=@foo_1.0-1_amd64.dsc" \
  -F "package=@foo_1.0-1_amd64.deb" \
  -F "package=@foo-dbgsym_1.0-1_amd64.deb" \
  -F "package=@foo_1.0-1_amd64.buildinfo" \
  -F "package=@foo_1.0.orig.tar.gz" \
  -F "package=@foo_1.0-1.debian.tar.xz" \
  http://<host>:<port>/upload/deb/<distribution>/<release>/<component>
```

#### PUT API

* `/upload/deb/<distribution>/<release>/<component>/<file>`
* `/upload/deb/<distribution>/<release>/<component>/<sub-component>/<file>`

The PUT API is meant to be used by `dput` and `dput-ng` tools. The example
`.dput.cf` corresponding to the section above for Debian Bookworm distribution
and `main` component could look like:

```ini
[bookworm-main]
fqdn=<username>:<password>@my-repo.example.com:80
incoming=/upload/deb/debian/bookworm/main
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
fqdn=<username>:<password>@my-repo.example.com:80
incoming=/upload/deb/debian/bookworm-security/updates/main
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
incoming=/upload/deb/debian/bookworm/main
method=http
distributions=bookworm
```

### RedHat-like Upload API

The Repository Management API (the `createrepo_c` tool) is not so strict like in
the Debian-like repository case, so it works even for single RPMs. For the
fictitious package `foo` version `1.0` the following files could be uploaded to
have both the source and binary RPMs:

* `foo-1.0-1.x86_64.rpm`
* `foo-1.0-1.x86_64.src.rpm`

#### POST API

* `/upload/rpm/<distribution>/<release>`

The POST API expects a `multipart/form-data` request with the field `package`
(can be changed, see [Configuration](#configuration) section) containing the
uploaded files. In case of multiple files in the same request, the field name
must be `package` without any additional brackets. The `curl` tool can be used
to upload the files with the following command:

```bash
curl -u "<username>:<password>" \
  -F "package=@foo-1.0-1.x86_64.rpm" \
  -F "package=@foo-1.0-1.x86_64.src.rpm" \
  https://<host>:<port>/upload/rpm/<distribution>/<release>
```

For example, to upload the package to Fedora release 41, the URI would look
like:

```url
https://my-repo.example.com/upload/rpm/fedora/41`
```

For **testing** with plain HTTP and disabled authorization one could use
`http` instead of `https` and omit the `-u` argument with the username and
password:

```bash
curl -F "package=@foo-1.0-1.x86_64.rpm" \
  -F "package=@foo-1.0-1.x86_64.src.rpm" \
  http://<host>:<port>/upload/rpm/<distribution>/<release>
```

#### PUT API

* `/upload/rpm/<distribution>/<release>/<file>`

The PUT API accepts single file uploads. The `curl` tool can be used to upload
the file:

```bash
curl -u "<username>:<password>" \
  -T "foo-1.0-1.x86_64.rpm" \
  https://<host>:<port>/upload/rpm/<distribution>/<release>/foo-1.0-1.x86_64.rpm
```

For example, to upload the package to Fedora release 41, the URI would look
like:

```url
https://my-repo.example.com/upload/rpm/fedora/41/foo-1.0-1.x86_64.rpm
```

If the URI ends with a slash `/`, the file name is appended by `curl`
automatically:

```bash
curl -u "<username>:<password>" \
  -T "foo-1.0-1.x86_64.rpm" \
  https://<host>:<port>/upload/rpm/<distribution>/<release>/
```

So in the same example as above, one would use:

```url
https://my-repo.example.com/upload/rpm/fedora/41/
```

It is also possible to upload multiple files in multiple requests with a single
command:

```bash
curl -u "<username>:<password>" \
  -T "{foo-1.0-1.x86_64.rpm,foo-1.0-1.x86_64.src.rpm}" \
  https://<host>:<port>/upload/rpm/<distribution>/<release>/
```

For **testing** with plain HTTP and disabled authorization one could use
`http` instead of `https` and omit the `-u` argument with the username and
password:

```bash
curl -T "foo-1.0-1.x86_64.rpm" \
  http://<host>:<port>/upload/rpm/<distribution>/<release>/
```

### Repository Management API

To build the repository from the uploaded files, send the `POST` request to the
`/upload/build-repo` endpoint. There is nothing read from the request body, so
it might be empty.

The repository build can be triggered by issuing the following `curl` command:

```bash
curl -u "<username>:<password>" \
  -X POST https://<host>:<port>/upload/build-repo
```

For **testing** with plain HTTP and disabled authorization one could use `http`
instead of `https` and omit the `-u` argument with the username and password:

```bash
curl -X POST http://<host>:<port>/upload/build-repo
```

The repository build prepares the configuration for the tools and calls the
`reprepro` and `createrepo_c` binaries to build the actual repositories.
Currently, the request is synchronous, so the response will come when the tools
finish their work. You can continue using the other APIs, even the file upload
API, while the repository build is in progress. The file upload API might be
delayed slightly, though, because the first step of the repository build is to
move the uploaded files to the processing directory for the tools to pick them
up. During this move operation, the upload API requests are delayed.

## Configuration

The configuration is stored entirely in the environment variables. The
description and default values of the environment variables are listed in the
file [`env.example`][env-example]. You can use this file as a template for your
own configuration and load it into the environment by one of the methods
mentioned in the following sections.

Please also check the [Quick Start](#quick-start) section for the list of
required tools.

### Docker Configuration

For Docker, make a copy of the [`env.example`][env-example] to `.env` file
(choose your name) and pass the path to the `docker run` command with
`--env-file .env` option:

```bash
docker run --detach \
  --name simple-repo-manager \
  --publish 80:3000 \
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
  --env UPLOAD_FIELD_NAME=file \
  --volume ./data:/app/data \
  simple-repo-manager
```

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
    volumes:
      - "./data:/app/data"
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

HTTPS server running on port 443 (default HTTPS port) with certificates located
in the current directory in `certs/key.pem` and `certs/cert.pem` files:

```dotenv
HTTP_PORT=443
HTTPS_KEY_FILE=certs/key.pem
HTTPS_CERT_FILE=certs/cert.pem
```

Upload API limited to only local accesses going through the reverse proxy
running on server 10.1.2.1 and filling `X-Forwarded-For` header:

```dotenv
TRUST_PROXY=10.1.2.1
UPLOAD_ALLOWED_IPS=loopback,10.1.2.0/24
```

Upload API protected by basic authentication with username `rico` and password
`kaboom`, and username `kowalski` and password `candy-canes`:

```dotenv
UPLOAD_BASIC_AUTH=rico:kaboom, kowalski:candy-canes
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
repository metadata:

```dotenv
GPG_PRIVATE_KEY_FILE=repo-key.asc
```

Use GPG public keys stored in the `gpg-keyring.asc` file and `gpg-public-keys`
directory for checking the uploaded packages by the `reprepro` tool for
Debian-like repositories:

```dotenv
GPG_PUBLIC_KEYS_FILE=gpg-keyring.asc
GPG_PUBLIC_KEYS_DIR=gpg-public-keys
```

Define `Origin:` and `Description:` tags separately for the Debian and Ubuntu
distributions metadata:

```dotenv
DEB_ORIGIN_DEBIAN=My Debian Repository
DEB_DESCRIPTION_DEBIAN=My Debian Repository for Debian distributions
DEB_ORIGIN_UBUNTU=My Ubuntu Repository
DEB_DESCRIPTION_UBUNTU=My Ubuntu Repository for Ubuntu distributions
```

Run the Docker container with UID `1001` and GID `1001`:

```dotenv
UID=1001
GID=1001
```

### Signing Repository Metadata

The repository metadata can be signed using GPG. The signing is done by the
`reprepro` tool for Debian-like repositories and by `rnp` tool for RedHat-like
repositories. The signing key is not generated and needs to be provided by the
administrator. The best practice is to use the same GPG private key used for
signing the packages, so the repository metadata is signed with the same key as
the packages themselves. The private key can be provided in the
`GPG_PRIVATE_KEY_FILE` environment variable, which can point to either an
ASCII-armored file (usually with `.asc` extension) or a binary file (usually  
with `.gpg` extension).

> [!IMPORTANT]
> Please note that the Repository Management API does not sign the uploaded
> packages; it only signs the metadata. The uploader must sign the packages
> themselves before uploading them to the repository.

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

The Debian-like repository metadata is signed by the `reprepro` tool and results
in the following files in the repository:

* `Release` file containing the metadata for the repository.
* `Release.gpg` file containing the GPG signature of the `Release` file.
* `InRelease` file containing the metadata for the repository in ASCII-armored
  format and signed by the GPG key.

The RedHat-like repository metadata is signed by the `rnp` tool and results in
the following files in the repository:

* `repodata/repomd.xml` file containing the metadata for the repository.
* `repodata/repomd.xml.asc` file containing the GPG signature of the
  `repodata/repomd.xml` file.

### Package Signatures

The repository manager does not sign the uploaded packages, it only signs the
repository metadata. The uploader must sign the packages themselves.

## Production Build

The recommended way to run the Simple Repository Manager in production is to use
Docker. The project provides a `Dockerfile` file to build the Docker image,
including all required tools (see [Quick Start](#quick-start) for the list of
tools). See below for details on how to build and run the Docker image.

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
run, and `scripts` to handle the RedHat-like repositories and signing. So to
create the smallest runnable application, you need to copy the `dist` and
`scripts` directories, as well as the `package.json` and `package-lock.json`
files to the target directory (the example uses `/app` directory, use any target
directory you like) and prepare the `node_modules` directory with the following
commands:

```bash
mkdir -p /app/dist
cp --recursive scripts/ dist/ package.json package-lock.json /app/
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

Please also check the [Quick Start](#quick-start) section for the list of
required tools.

### Docker Build

To build the Docker image, run the following command in the root of the project
directory:

```bash
docker build -t simple-repo-manager .
```

This will create a Docker image with the name `simple-repo-manager`. The
`Dockerfile` contains all the necessary tools, including `createrepo_c`,
`reprepro`, `rnp` and `gpg`, so the image is self-contained and can be used to
run the application in production.

The Docker image exposes the port `3000` and by default expected the data
directory to be mounted to `/app/data` in the container. The data directory
contains the repository data, so it needs to be persistent. To run the Docker
image on port 80 and use local directory `data` for persistent repository
storage, you can use the following command:

```bash
docker run --detach \
  --name simple-repo-manager \
  --publish 80:3000 \
  --volume ./data:/app/data \
  simple-repo-manager
```

The Docker container uses user `node` with UID `1000` and GID `1000` by default
to run the application. The entrypoint script `entrypoint.sh` is initially
started as user `root` and fixes the ownership of the `INCOMING_DIR`,
`REPO_DIR`, `REPO_STATE_DIR` and optionally `GPGHOMEDIR` directories recursively
during startup. The numerical user and group IDs can be changed by setting the
`UID` and `GID` environment variables passed to the started container like in
the following command:

```bash
docker run --detach \
  --name simple-repo-manager \
  --publish 80:3000 \
  --volume ./data:/app/data \
  --env UID=1001 --env GID=1001 \
  simple-repo-manager
```

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

See the [Configuration](#configuration) section for details on how to configure
the Docker Compose environment.

## Troubleshooting

### Repository Management API Call Failed

If you encounter any issues with the repository management tools, consult the
server logs for the executed commands and execute the commands manually to see
the output and debug the issue.

If you run the application in Docker, you can view the logs with the following
command:

```bash
docker logs simple-repo-manager
```

or in the case of the Docker Compose:

```bash
docker compose logs simple-repo-manager
```

You can then enter the Docker container and run the commands manually to
troubleshoot the issue with the following command:

```bash
docker exec -u node -it simple-repo-manager /bin/bash
```

or in the case of the Docker Compose:

```bash
docker compose exec -u node simple-repo-manager /bin/bash
```

Then you can execute the commands from the logs to see the output and debug the
issue. If you have the persistent storage mounted as a host directory into the
container, you can benefit from using the local editor instead of editing the
files in the container directly.

Please note the argument `-u node`, which starts `/bin/bash` inside the
container as user `node`. The default is user `root`, so if you omit the
`-u node` argument, you will enter the container as the `root` user.

> [!IMPORTANT]
> If you omit the `-u node` option and enter the container as the `root`
> user, some files inside the `INCOMING_DIR`, `REPO_DIR` or `REPO_STATE_DIR`
> might not be fully accessible by the `node` user. The entrypoint script
> [`entrypoint.sh`][entrypoint] will fix the ownership of these files on the
> next container restart, so if you used the user `root` to test anything
> inside the container, simply restart the container to fix the file
> permissions.

[entrypoint]: https://github.com/oldium/simple-repo-manager/blob/master/entrypoint.sh

### Regenerate Metadata Signatures

If you have made any manual changes and need to regenerate the signatures, call
the [Repository Management API](#repository-management-api) endpoint to build
the repository metadata.

The Debian-like repository metadata signatures should be maintained by the
`reprepro` tool already, because the signature script is automatically
configured to run. So if you have made some manual changes and called the
`reprepro` tool, the signatures should be up to date already.

For the RedHat-like repository metadata, the signature is generated by the
`createrepo.sh` script, so either call the API mentioned above to call it for
you, or run the script manually (use your real directories and ensure that the
`GPG_REPO_PRIVATE_KEY_FILE` environment variable is set correctly):

```bash
cd /app
GPG_REPO_PRIVATE_KEY_FILE=/path/to/private-key.asc \
  ./scripts/createrepo.sh /app/data/repo/rpm/<distribution>/<release> ./scripts/sign.sh
```

## About the Project

### Why?

There are some OpenSource alternatives like [OpenRepo][openrepo] or
[Pulp][pulp]. However, the former one has not seen release since 2022 and for
the latter one you need to create multiple scripts to make it working
(including patching the embedded Nginx configuration to run behind the
SSL-terminating Nginx reverse proxy).

So I decided to create a simple repository manager, which does only the basics
(package uploads, signing the repository metadata) and does not reinvent the
wheel, so existing tools like `reprepro` and `createrepo_c` are used to manage
the repositories.

When used with Docker, the project is self-contained, so it does not require any
external Nginx reverse proxy but can run behind it as well.

[openrepo]: https://github.com/openkilt/openrepo

[pulp]: https://www.pulpproject.org/
