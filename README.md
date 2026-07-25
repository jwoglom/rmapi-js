# rmapi-js

[![build](https://github.com/erikbrinkman/rmapi-js/actions/workflows/build.yml/badge.svg)](https://github.com/erikbrinkman/rmapi-js/actions/workflows/build.yml)
[![docs](https://img.shields.io/badge/docs-docs-blue)](https://erikbrinkman.github.io/rmapi-js/modules.html)
[![npm](https://img.shields.io/npm/v/rmapi-js)](https://www.npmjs.com/package/rmapi-js)
[![license](https://img.shields.io/github/license/erikbrinkman/rmapi-js)](LICENSE)

JavaScript implementation of the reMarkable api. It should also be pretty easy
to customize to work with
[rmfakecloud](https://github.com/ddvk/rmfakecloud), although that might take a
little bit of extra plumbing.

## API

Before using this API it's necessary to have some rudimentary understanding of
how the API works.

All data is stored via its sha256 hash. This includes raw files ("documents")
and folders ("collections"). The hash indicates the full current state to manage simultaneous edits. Most entries or edits will take an input hash, and return an output hash. Additionally, every entry has an id, which is a uuid4, and remains constantant over the lifetime of the file or folder. There are two special ids, "" (the empty string) which corresponds to the root collection, e.g. the default location for all files, and "trash", which is the trash.

## Usage

To explore files in the cloud, you need to first register your api and persist
the token. Then you can use `listItems` to explore entries of different file
collections.

```ts
import { auth, register, remarkable, session } from "rmapi-js";

const code = "..."; // eight letter code from https://my.remarkable.com/device/desktop/connect
const token = await register(code);
// persist token so you don't have to register again
const api = await remarkable(token);
const fileEntries = await api.listItems();

// In stateless environments, exchange once and reuse.
const sessionToken = await auth(token);
const sessionApi = session(sessionToken);
// cache `sessionToken` and reuse it across workers
```

`auth` performs the same network call that `remarkable` does for you internally,
returning a short-lived session token. `session` is synchronous,
letting you construct clients from cached tokens without making a network call.

To upload an epub or pdf, simply call upload with the appropriate name and buffer.

```ts
import { remarkable } from "rmapi-js";

const api = await remarkable(...);
await api.uploadEpub("name", buffer);
await api.uploadPdf("name", buffer);
```

There are alos low level apis that more directly manipulate cloud storage.
Using these apis is a little riskier since they can potentially result in data loss, but it does come with increased flexibility.

```ts
// ...

// upload with custom line height not avilable through reMarkable
await api.putEpub("name", buffer, { lineHeight: 180 })

// fetch an uploaded epub, using the id and hash (from listItems)
const buffer = await api.getEpub(id, hash)
```

### Gotchas

By default, all calls try to do their best to verify that the input and output
matches what I expect. However, since I reverse-engineered this, some of it
could be wrong. If you ever run into a `ValidationError` and know you want
whatever data is returned, You'll have to use the low-level api under `api.raw`
to access the raw text file and parse the result yourself.

It seems that exporting happens within the apps themselves, which will require
layout of the remarkable file structure. That's currently outside the scope of
this project.

## CLI

This package also ships a command line client, `rmapi`, that wraps the whole
library, including the low-level `raw` api.

### install

```sh
npx rmapi --help
npm install -g rmapi-js && rmapi --help
```

Running from a checkout uses bun, and everything after `--` goes to the cli:

```sh
bun run cli -- ls /
bun run cli -- put --help
```

### getting started

Get an eight letter code from
<https://my.remarkable.com/device/browser/connect> and register with it:

```sh
rmapi auth register ABCDEFGH
rmapi auth status
rmapi ls /
```

The resulting device token never expires, so registering is a one time thing.
It's written to `config.json` in the config directory with mode 0600, along
with a cached session token, which is refreshed automatically when it expires.
`rmapi cache path` prints the files actually in use; the directory resolves
from `--config`, then `RMAPI_CONFIG_DIR`, then `$XDG_CONFIG_HOME/rmapi-js`,
then `~/.config/rmapi-js`.

`rmapi auth token` only prints the token if you also pass `--print-token`.
`rmapi auth logout` forgets the stored device token, session token, and hash
cache.

### addressing items

The cloud stores a flat list of entries with parent ids, so paths are
synthesized by the cli. Anything that takes a target accepts a path, a uuid,
or a sha256 hash, detected from its shape:

```sh
rmapi stat /Books/Notes.pdf
rmapi stat 0ac1e0dc-b3a6-4e3e-a4f6-a4f6f0e0a1b2
rmapi stat 6b7f0d05e0e2b0dbf99d2ee4a1d1a6b1b0f0b0e1b0e1b0e1b0e1b0e1b0e1b0e1
```

Prefixes force an interpretation, which is how you name a document that looks
like a uuid or a hash:

```sh
rmapi stat path:/Books/0ac1e0dc-b3a6-4e3e-a4f6-a4f6f0e0a1b2
rmapi stat id:0ac1e0dc-b3a6-4e3e-a4f6-a4f6f0e0a1b2
rmapi stat hash:6b7f0d05e0e2b0dbf99d2ee4a1d1a6b1b0f0b0e1b0e1b0e1b0e1b0e1b0e1b0e1
```

Paths are always absolute, so the leading `/` is optional. `/` is the root and
`/trash` is the trash; `id:` is the root and `id:trash` the trash. Names are
compared against `visibleName` exactly, including case. reMarkable names may
contain `/`, which is escaped with a backslash in a path, so a document
literally called `a/b` in the root is `/a\/b`.

Duplicate sibling names are legal on reMarkable, so a path can match more than
one item. That's an error rather than a guess, and the fix is to address the
one you want by id:

```sh
rmapi find / --name Notes -l   # shows the ids
rmapi rm id:0ac1e0dc-b3a6-4e3e-a4f6-a4f6f0e0a1b2
```

Two synthetic containers show up for malformed data instead of crashing:
`/.orphans` for entries whose parent doesn't exist, and `/.cycles` for entries
caught in a parent cycle. `rmapi tree --all` renders them.

### commands

auth

| command | |
| --- | --- |
| `rmapi auth register <code>` | register this machine and persist a device token |
| `rmapi auth status` | show whether this machine is registered |
| `rmapi auth token` | print the stored device token |
| `rmapi auth logout` | forget the stored device token, session token, and hash cache |

reading

| command | |
| --- | --- |
| `rmapi ls [path]` | list items |
| `rmapi tree [path]` | show the collection hierarchy as a tree |
| `rmapi find [path]` | find items matching a filter |
| `rmapi stat <target>` | show a summary of an item's metadata and content |
| `rmapi meta <target>` | print the raw metadata of an item |
| `rmapi content <target>` | print the raw content of an item |
| `rmapi get <target>` | download the source file of a document |

writing

| command | |
| --- | --- |
| `rmapi put <file> [dest]` | put a pdf or epub onto reMarkable |
| `rmapi mkdir <path>...` | create collections (folders) |
| `rmapi update <target> --set key=value...` | update the content metadata of an item |
| `rmapi mv <target>... <dest>` | move items into a collection |
| `rmapi rm <target>...` | move items to the trash |
| `rmapi rename <target> <name>` | rename an item |
| `rmapi star <target>...` | star items |
| `rmapi unstar <target>...` | unstar items |

utility

| command | |
| --- | --- |
| `rmapi cache path` | print where the config and hash cache live |
| `rmapi cache info` | summarize the persisted hash cache |
| `rmapi cache dump` | print the in-memory hash cache |
| `rmapi cache prune` | drop unreachable hashes from the cache |
| `rmapi cache clear` | empty the hash cache |
| `rmapi devices` | list the known reMarkable devices and their screens |
| `rmapi devices zoom` | compute the customFit zoom settings for a device and page size |

`rmapi --help` lists every command, and `rmapi <command> --help` documents its
flags. `mv`, `rm`, `star`, and `unstar` take several targets, and a `-` target
reads more targets from stdin.

`rm` moves items to the trash. The api has no way to erase anything, so
nothing in this cli deletes data permanently; empty the trash from a
reMarkable device or the web app.

`put` uses the low-level api, which is why it accepts a destination, tags,
reader settings, and the rest. That api writes against the current root
generation, so a concurrent change makes it fail as stale; the cli retries
that automatically (`--retries`, default 3). `put --simple` uses the simpler
upload api instead, which is more robust but takes no other options at all: it
always uploads into the root under the given name.

### global flags and environment

| flag | |
| --- | --- |
| `--json` | emit json instead of formatted text |
| `--refresh` | refresh the root hash before reading |
| `--no-cache` | ignore the persisted hash cache |
| `--cache-file <value>` | path to the hash cache file |
| `--config <value>` | path to the config directory |
| `--raw-host <value>` | host for low-level api requests |
| `--upload-host <value>` | host for upload requests |
| `--auth-host <value>` | host for authorization requests |
| `--retries <value>` | retries for stale generation errors (default 3) |
| `-v`, `--verbose` | emit extra diagnostics |
| `--quiet` | suppress non-essential output |
| `--yes` | assume yes for every confirmation |
| `--version` | print the version and exit |
| `--help` | print this help and exit |

`--json` is the one to reach for in scripts: every command emits machine
readable output with it, and errors come out on stderr as
`{"error": ..., "code": ...}`.

| variable | |
| --- | --- |
| `RMAPI_DEVICE_TOKEN` | use this device token instead of the stored one |
| `RMAPI_CONFIG_DIR` | where to keep the config and hash cache |
| `RMAPI_AUTH_HOST` | host for authorization requests |
| `RMAPI_RAW_HOST` | host for low-level api requests |
| `RMAPI_UPLOAD_HOST` | host for upload requests |
| `RMAPI_ALLOW_RAW_WRITE` | set to `1` to allow `raw` writes without `--yes` |
| `NO_COLOR`, `FORCE_COLOR` | turn styling off or on |

Flags win over the environment, which wins over the hosts saved in the config
file. Pointing the three hosts elsewhere is what makes the cli usable against
[rmfakecloud](https://github.com/ddvk/rmfakecloud):

```sh
export RMAPI_AUTH_HOST=https://local.appspot.com
export RMAPI_RAW_HOST=https://local.appspot.com
export RMAPI_UPLOAD_HOST=https://local.appspot.com
rmapi auth register ABCDEFGH
```

`RMAPI_DEVICE_TOKEN` is the way to run in CI without a config file at all.

### scripting

```sh
# every pdf in the cloud, by path
rmapi find / --file-type pdf --json | jq -r '.[].path'

# ids of everything tagged 'inbox', starred one at a time
rmapi find / --tag inbox --json | jq -r '.[].id' | rmapi star -

# the name and last modified time of every starred item
rmapi find / --pinned --json | jq -r '.[] | [.visibleName, .lastModified] | @tsv'

# trash everything under a folder
rmapi ls /Scratch --json | jq -r '.[].id' | rmapi rm -

# how many items are in the trash
rmapi ls /trash --json | jq length
```

Exit codes:

| code | |
| --- | --- |
| 0 | success |
| 1 | unexpected error |
| 2 | usage error |
| 3 | target not found, ambiguous, or a missing hash |
| 4 | authorization failed, or no device token |
| 5 | validation error, the response didn't match what we expect |
| 6 | stale root generation, after exhausting `--retries` |

### the raw commands (dangerous)

`rmapi raw ...` exposes the low-level storage api directly: fetching and
uploading hashes, metadata, content, entry lists, and the root hash. It's for
inspecting or repairing an account that the normal commands can't express, and
for reading files that fail validation (`raw get-text` shows what `raw
get-content` and `raw get-metadata` reject).

These commands manipulate cloud storage directly and can cause data loss.
Nothing is checked against the rest of the account: a bad write can leave
documents unreadable, and `raw put-root-hash` in particular can orphan the
entire file tree, making every document disappear. Save the current root hash
first, since it's the snapshot you can restore to:

```sh
rmapi raw get-root-hash --json
rmapi raw get-entries root.docSchema <root-hash>
```

Every `raw` write refuses to run unless you pass `--yes` or set
`RMAPI_ALLOW_RAW_WRITE=1`.

| command | |
| --- | --- |
| `rmapi raw get-root-hash` | print the current root hash, generation, and schema version |
| `rmapi raw get-entries <file-name> <hash>` | list the entries of a list hash |
| `rmapi raw get-hash <file-name> <hash>` | fetch the raw bytes of a hash |
| `rmapi raw get-text <file-name> <hash>` | fetch the text of a hash |
| `rmapi raw get-metadata <file-name> <hash>` | fetch and validate a metadata file |
| `rmapi raw get-content <file-name> <hash>` | fetch and validate a content file |
| `rmapi raw put-root-hash <hash> <generation>` | point the account at a new root hash |
| `rmapi raw put-entries <id> <json\|@file\|-> <schema-version>` | upload an entry list file |
| `rmapi raw put-file <id> <path>` | upload the bytes of a file |
| `rmapi raw put-text <id> <text\|@file\|->` | upload a text file |
| `rmapi raw put-metadata <id> <json\|@file\|->` | upload a metadata file |
| `rmapi raw put-content <id> <json\|@file\|->` | upload a content file |
| `rmapi raw upload-file <visible-name> <path> <mime>` | upload a file with the simple upload api |

## Users

- [✉️ Send Via](https://sendvia.me/) [[github](https://github.com/PaulKinlan/send-to-remarkable)] - upload to reMarkable via email
- [ⓡ rePub](https://chromewebstore.google.com/detail/repub/blkjpagbjaekkpojgcgdapmikoaolpbl) [[github](https://github.com/hafaio/repub)] - web clipper for reMarkable that supports images and customization
- [reMarkable Digest](https://digest.ferrucc.io) - create and receive a daily digest on your reMarkable

## Contributing

Since this has all been reverse engineered, any help expanding the api would be
helpful. For example, There's currently a function to download the entire state
of a document, but I ran into trouble trying to reupload that exact same file as
a clone.

You can also run `bun doc:md` to generate Markdown docs in `docs-md/`, which can
be handy when sharing context.
