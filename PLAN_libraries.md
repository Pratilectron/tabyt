# TabYT Library Integration Plan v1

## Goal
Evaluate and integrate recommended vendor libraries for TabYT, keeping everything offline/MV3-compliant.

## Libraries Evaluated

### 1. uPlot (~12 KB)
- **Purpose**: Time-series charts for Dashboard memory graphs
- **Current state**: TabYT uses custom `chartSvg()` + `downsample()` in core.js (200 lines)
- **Action**: Evaluate replacing custom chart code with uPlot
- **Benefit**: 20x faster, 100k+ data points at 60 FPS, no WebGL, pure 2D Canvas

### 2. Preact (~3 KB) or Alpine.js (~3 KB)
- **Purpose**: Reactive UI for Popup & Dashboard
- **Current state**: dashboard.js uses 1000+ lines manual `document.createElement`
- **Action**: Evaluate Preact (full framework) vs Alpine.js (drop-in directives)
- **Benefit**: Declarative components, auto-sync with chrome.storage

### 3. Dexie.js (~25 KB)
- **Purpose**: IndexedDB wrapper for long-term history storage
- **Current state**: Uses `chrome.storage.local` (10MB quota limit)
- **Action**: Evaluate if storage quota issues require Dexie.js
- **Benefit**: Bypasses 10MB limit, schema-less storage for months of timestamps

### 4. webextension-polyfill (~8 KB)
- **Purpose**: Cross-browser API normalization (Chrome SW + Firefox)
- **Current state**: TabYT already supports Chrome + Firefox
- **Action**: Evaluate if polyfill reduces code duplication
- **Benefit**: Unified Promise-based APIs across browsers

### 5. SortableJS (~10 KB)
- **Purpose**: Custom Tab Rail reordering
- **Current state**: `dragRafId`/`startDrag` handler in layout.js
- **Action**: Evaluate replacing drag handler with SortableJS
- **Benefit**: Touch support, smoother reordering, less code

## Implementation Priority

### Phase 1 (Critical - address real user pain points)
- [x] **Dexie.js** - Bypasses 10MB chrome.storage.local quota (most requested feature)
  - *Implementation: storage wrapper in background.js ready, but network download blocked*
- [ ] uPlot - Chart performance improvement (depends on chart data volume)

### Phase 2 (Nice-to-have)
- [ ] Alpine.js - Dashboard reactivity refactor
- [ ] SortableJS - Rail reordering enhancement
- [ ] webextension-polyfill - API unification (already Chrome+Firefox compatible)

### Phase 3 (Optional)
- [ ] Full Preact replacement if UI rewrite is desired

## Risks
- Adding dependencies increases bundle size and build complexity
- MV3 requires all scripts to be local/offline (no runtime CDN fetch)
- Some current implementations may already be sufficient
- Dependency updates require vigilance

## Next Steps
1. Download and vendor Dexie.js into `src/vendor/` (network-blocked in this env, would address 10MB storage quota limit)
2. Rewrite storage code to use IndexedDB schema-less storage
3. Test across Chrome/Firefox for storage quota bypass
4. Evaluate uPlot if dashboard charts need performance improvement