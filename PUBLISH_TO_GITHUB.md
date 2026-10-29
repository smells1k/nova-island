# Publish the source on GitHub

This is the source project only. `release/`, `node_modules/`, local test screenshots, and build caches are intentionally excluded. The Windows installer is about 116 MB; keep it out of normal Git history and attach it to a GitHub Release instead.

1. Create an empty repository on GitHub (do not initialize it with a README or license).
2. In this folder, run:

```bash
git init -b main
git add .
git commit -m "Initial NOVA Island source"
git remote add origin https://github.com/YOUR-NAME/YOUR-REPOSITORY.git
git push -u origin main
```

Authenticate using GitHub's browser-based sign-in or Git Credential Manager. Do not paste a personal access token into chat.
