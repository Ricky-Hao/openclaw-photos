# openclaw-photos

Tag-based photo library plugin for [OpenClaw](https://github.com/nicepkg/openclaw).

Store images with collections and tags. Retrieve randomly by tag/collection. List stats. Delete by ID.

## Features

- **Save photos** — download from URL, store locally with SHA-256 dedup
- **Get photos** — random retrieval, filtered by collection and/or tags (OR match)
- **List** — collection counts and tag statistics
- **Delete** — remove by ID from DB and disk

## Tools

| Tool | Description |
|------|-------------|
| `photo_save` | Save a photo to the library with tags and collection |
| `photo_get` | Get random photo(s), optionally filtered |
| `photo_list` | List collections and tag statistics |
| `photo_delete` | Delete a photo by ID |

## Installation

Add to `openclaw.json`:

```jsonc
"plugins": {
  "allow": ["openclaw-photos"],
  "entries": {
    "openclaw-photos": {
      "source": "/path/to/openclaw-photos",
      "config": {
        "dataDir": "/home/user/.openclaw/data/photos"
      }
    }
  }
}
```

Then allow tools in agent config:

```json
"alsoAllow": ["photo_save", "photo_get", "photo_list", "photo_delete"]
```

## Development

```bash
npm install
npm run build
npm test
```

## Storage Layout

```
<dataDir>/
├── photos.db              # SQLite database
└── images/
    ├── <collection>/
    │   ├── <id>.jpg
    │   ├── <id>.png
    │   └── ...
    └── ...
```

## License

MIT
