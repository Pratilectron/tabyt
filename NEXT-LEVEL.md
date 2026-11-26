# What actually levels TabYT up

Research across npm, GitHub, Chrome extension policy, and the YouTube player APIs. Sources checked November 2026. Ranked for this extension: performance first, aesthetics second, local-only, Manifest V3, Chrome 121+ and Firefox 142+.

TabYT keeps YouTube's player and only rearranges the watch page. A move that replaces the player, fetches a second copy of data the page already embedded, or reads pixels back into JavaScript is a step down.

## Where it stands

Shipped in the extension, not still on the list:

- The watch JSON is read in the MAIN world by `src/page-data.js`. `extractWatchMeta` takes `videoDetails.shortDescription` and chapter rows from the engagement panels, with player markers as the fallback. No network call.
- Chapter rows from that JSON seek the existing player.
- The glow is `createFrameGlow` in `src/layout.js` (1.0.37). Two draws of a bitmap about 96 pixels on the long side, about eight times a second. The first pass is `blur(5px) saturate(1.35) brightness(0.8)` of the video, overscanned so the edges stay colored. The second pass is `blur(8px)` from an off-document scratch canvas onto the one visible canvas. `requestVideoFrameCallback` only starts a sample. The loop stops while the tab is hidden or the video is paused. There is no `getImageData`. `video-ambient-glow` is gone; only its license file remains.
- Inactive rail panels use `content-visibility: hidden`, so Comments, Related, and Live are not laid out until opened.
- Fit uses a `ResizeObserver` on `#primary` and `#below`. The document `MutationObserver` still watches the whole tree, then drops player and rail-internal records in `mutationMatters`.

The layout is already a theater split: player on the left, comments and the other tabs on the right. The divider exists and is off until Player resizing is turned on. Ambient glow is on by default. Theater on the custom bar clicks YouTube's own theater button. There is no forced-theater setting.

## Two hard limits

Manifest V3 will not execute JavaScript from jsDelivr, esm.sh, unpkg, or cdnjs. Extension pages are limited to `script-src 'self'`. A CDN is only a place to download a file once and vendor it.

SponsorBlock, DeArrow, Return YouTube Dislike, and youtubei.js all make network requests. SponsorBlock segment marks are already an opt-in switch (`layoutSkips`) and send a hash prefix of the video id. Any new network feature needs the same shape: off unless the user turns it on, and not on the path that paints the watch page.

## youtubei.js

[youtubei.js](https://github.com/LuanRT/YouTube.js) 18.3.0 (npm, MIT, published line checked November 2026) is a client for YouTube's private InnerTube API. It is not full access, and it is not a stabler channel than the JSON already on the watch page.

`getInfo` calls the watch endpoint and the watch-next endpoint. `getBasicInfo` calls watch only. For a normal public video that returns:

- Title, duration, channel, view count, short description, thumbnails, and playability.
- Related videos and engagement panels, including chapters when watch-next is included.
- `captions.caption_tracks`, each with a timed-text URL.
- Comments through `getComments`.
- Search, channel, playlist, and Shorts helpers.

What it does not reliably return:

- `getTranscript()` posts to `youtubei/v1/get_transcript`. The author reported that call bot-guarded: status 400, and a BotGuard attestation from `/att/get` (`ENGAGEMENT_TYPE_UNBOUND`) is required. That was still open as issue 1102. The caption-track URL is a different request and is the path that still returns text. It is not the transcript endpoint.
- `getLiveChat()` throws `Live Chat is not available` when the parsed response has no LiveChat node. Issue 1135 (16.0.1, February 2026) hit that on a stream whose chat was public. Later versions may parse more responses. The rule in the code is unchanged: no node, no chat.
- Playback URLs. Untrusted clients get `playability_status` `LOGIN_REQUIRED` with the reason "Sign in to confirm you're not a bot". A Proof of Origin token is an optional session field (`po_token`), not a guarantee. Age-restricted, members-only, private, and region-blocked videos stay behind the same playability wall and need a signed-in session for some of them. Deciphering a format URL means running YouTube's player script. The library parses it with `meriyah` and the guide requires the host to supply an `eval` shim. Extension pages cannot grant that. SABR, the server-side adaptive stream, is a separate protocol in `googlevideo`, not a metadata read.
- Dislike counts. InnerTube does not carry them. That is why Return YouTube Dislike exists as its own API.
- A published quota. This is not Data API v3. Blocks are bot and IP responses, not a documented unit budget. The minified `web.bundle.min` stopped shipping in v13, so an extension would vendor and minify the client itself.

On a watch page, `ytInitialPlayerResponse` and `ytInitialData` are those same payloads, already parsed by YouTube. Calling `getInfo` fetches them again and fails closed when the page has already succeeded. That costs a round trip and can paint nothing when the embedded objects are sitting right there.

Do not put youtubei.js on the hot path. Do not use it to replace the player, to pull transcripts, or to open live chat. A later fallback is allowed only when both embedded objects are missing after navigation, only for the plain fields `extractWatchMeta` already understands, and only behind a switch that stays off. Until that gap shows up in real watches, the fallback is not worth the client.

## Moves still worth doing

| Move | Why it still pays | Cost |
| --- | --- | --- |
| Narrow the mutation observer | Records are filtered after delivery. Observing `#columns` or the rail roots, instead of `documentElement` with `subtree`, cuts the callback traffic while YouTube plays. Fit already ignores this observer. | Keep `mutationMatters`. Change the observe root. |
| Softer radial mask, only if the two-pass wash still looks patchy | The mask in `layout.css` is already the falloff. Editing the gradient stops is paint-only. It does not sample the video. | CSS. No second canvas, no extra timer. |
| Nothing else on the glow | A larger bitmap shows more blotches once it is stretched, and it multiplies the pixels at the same 8 Hz. WebGL, a second video element, and `getImageData` are the costs youtube-ambilight already paid. | Leave `createFrameGlow` at 96 pixels and 125 ms. |

## Projects worth reading

None of these were vendored. The notes are what to copy and what to leave.

- [youtube-ambilight](https://github.com/WesselKroos/youtube-ambilight) is Ambient light for YouTube, the same project that gets called YouTube Amplify out loud. It is the failure to avoid. Reading pixels on the main thread costs about 8 ms, sometimes 16 ms. Their worker path is blocked by YouTube's page CSP. Chrome has not restored extension workers there (issue 41098022). Their look is richer (WebGL, per-edge light, black-bar removal, frame blending) and their own listing says a weak GPU makes the watch page stutter. TabYT answered the warning with the two-pass 96-pixel draw, not with their renderer. Do not add their settings catalog.
- [Astra-Deck](https://github.com/SysAdminDoc/Astra-Deck) is the closest layout peer: a theater split with a divider, comments beside the video, and ambient glow off by default. MIT. The split is already TabYT's. Their glow-off default was not taken; `layoutAmbient` stays on. Leave the ad blocker and the download tools.
- [YouTube Enhancer](https://github.com/YouTube-Enhancer/extension) is a settings catalog, including forced theater mode. It is not a rendering technique. TabYT does not force theater.
- [FastStream](https://github.com/Andrews54757/FastStream) replaces the YouTube player and pulls info through youtubei.js. That is the opposite of this extension.

## Libraries scored for this codebase

"Use" means vendor the file. None of these should load from a CDN at runtime.

| Project | License | Fit | Verdict |
| --- | --- | --- | --- |
| Own `createFrameGlow` | Project code | 96-pixel bitmap, two blurs, 8 Hz, no readback. | Keep. This is the glow. |
| [@videoglow/video](https://github.com/brunos3d/video-ambilight) | Check before copying | `requestVideoFrameCallback`, 30 fps cap, no `getImageData`, pauses offscreen. | Superseded by the in-tree glow. Skip the YouTube package: it starts a second player and downloads the stream twice. |
| video-ambient-glow 1.2.6 | MIT | Read pixels back in JavaScript. | Removed. Do not bring it back. |
| [youtubei.js](https://github.com/LuanRT/YouTube.js) 18.3.0 | MIT | InnerTube client. See the section above. | Not the data path. Fallback only if the embedded JSON is actually missing, and not for streams. |
| YouTube IFrame Player API | YouTube terms | For sites that embed a player. | The watch page is not an embed, and iframe pixels cannot be sampled. |
| video-ambient, ambient-video, react-ambient-light | MIT | Smaller glow experiments, some React-only. | Weaker than the in-tree two-pass. React does not belong here. |
| [SponsorBlock](https://github.com/ajayyy/SponsorBlock) | GPL-3.0 code, CC BY-NC-SA data | Segment list only. TabYT already draws marks from `GET /api/skipSegments` and does not skip playback. | Stay opt-in. Do not copy GPL into this MIT extension. Do not auto-skip. |
| [Return YouTube Dislike](https://github.com/Anarios/return-youtube-dislike) and [DeArrow](https://github.com/ajayyy/DeArrow) | GPL-3.0 | Dislike counts, calmer titles and thumbnails. | RYD allows API use with attribution: 100 requests per minute, 10,000 per day. DeArrow replaces titles in feeds, which TabYT does not render. Opt-in only, and not next. |

## Platform facts

### requestVideoFrameCallback

Baseline since October 2024. Chrome 83, Firefox 132. TabYT's floor is Chrome 121 and Firefox 142, so it is safe. The callback runs at the slower of the video frame rate and the display refresh. It does not promise every frame. Heavy work inside it drops frames. The glow uses it to arm a 125 ms sample, then waits. Fall back to calling the paint directly only if the method is missing.

### Where the full description already is

`ytInitialPlayerResponse.videoDetails.shortDescription` is the full description. Chapter rows are in `ytInitialData`, under the engagement panel `engagement-panel-macro-markers-description-chapters`. Clicking "...more" and cloning the expander is the slow path. That reader is shipped.

### Isolated world

Those objects live on the page window. A content script in the isolated world sees a different window. `page-data.js` runs in the MAIN world and writes the plain JSON onto `data-tabyt-meta`. Do not inject a remote script to do it.

## Leave these out

A second video element for the glow. WebGL projectors. youtubei.js on the hot path, and youtubei.js for streams, transcripts, or live chat. The IFrame Player API. React. jQuery. Any runtime CDN. A glow settings catalog. Forced theater. An ad blocker or a downloader borrowed from Astra-Deck or FastStream. A larger glow bitmap and any `getImageData` readback.

They add decode cost, bundle size, a network call, or a main-thread stall. The watch page already holds the player and the same data, and the 96-pixel two-pass glow is the aesthetic step that stays inside the performance budget.
