# Showcase — share what you built

The [Showcase](https://bagidea.github.io/bagidea-office/showcase.html) is a community
gallery of work built **with or inside** BagIdea Office: a custom office, a project your
AI agents shipped, a plugin in action, generated art, a video — anything. Submitting is a
great way to show your work, and you're **credited as a contributor**.

## How to submit (one PR)

1. **Add a cover image.** Take a wide (~16:9) screenshot or image of your work and add it
   to `web/img/showcase/` in the repo — e.g. `web/img/showcase/my-thing.png`.
   - Keep it in the repo (don't hotlink a CDN/social URL — those expire and break).
   - PNG, JPG or WebP. A reasonable size (≤ ~1 MB) is appreciated.
2. **Add your entry** to `web/showcase.json`, in the `items` array:
   ```json
   {
     "title": "My AI marketing team",
     "author": "your-github-handle",
     "image": "img/showcase/my-thing.png",
     "url": "https://github.com/you/your-repo",
     "tag": "web app",
     "desc": "One or two sentences on what you built and how the office helped."
   }
   ```
   | field | notes |
   |---|---|
   | `title` | short, punchy |
   | `author` | your GitHub handle (no `@`) — the card links to your profile |
   | `image` | path under `web/`, e.g. `img/showcase/my-thing.png` |
   | `url` | where people can see/learn more (repo, site, video, a post) |
   | `tag` | *(optional)* one short label, e.g. `office`, `web app`, `plugin`, `art` |
   | `desc` | a sentence or two; write it in English so everyone can read it |
3. **Open a pull request.** We review and merge it **preserving your authorship**, so you
   land on the [Contributors graph](https://github.com/bagidea/bagidea-office/graphs/contributors)
   and your card appears on the Showcase page.

## Notes

- This is for finished/real work — not a place to advertise. Keep it genuine.
- The maintainer reviews every PR (the showcase is public-facing).
- Credit also lives in [CONTRIBUTORS.md](../../CONTRIBUTORS.md).
