# Draft: Folder-Based Coloring & UI Enhancements

## Requirements (confirmed)

- Barevne zalozky podle slozky ve ktere byl terminal otevren
- Multi-barevne zalozky pri slouceni vice slozek
- Barevne ramecky oken odpovidajici barve zalozky
- Dynamicke skalovani obsahu pri resize (min/max)
- Horizontalni scrollbar pro workspace s hodne okny
- Vertikalni scrollbar v jednotlivych oknech (pomale scrollovani)
- Close button pri hover v rohu s potvrzovacim dialogem

## Current State Analysis

### What Exists:

1. **Tabs**: Have `.tab-dot` indicator, `.tab.multicolor` class with gradient
2. **GROUP_COLORS**: `["#58a6ff", "#3fb950", "#d29922", "#bc8cff", "#f778ba", "#79c0ff", "#7ee787"]`
3. **Tile borders**: `.tile.grouped` uses `--group-color` CSS variable
4. **Terminal cwd**: Tracked in terminal metadata, but NOT used for coloring
5. **xterm scrollbar**: Basic `.xterm-viewport { overflow-y: scroll }`
6. **Tab close button**: Exists in tab bar, not in window corner

### What's Missing:

1. **Folder → Color mapping**: No system to assign colors to folder paths
2. **Multi-color tabs**: Logic for combining multiple folder colors
3. **Dynamic content scaling**: No font/content resize during window resize
4. **Horizontal workspace scroll**: Tiles use % positioning, no overflow handling
5. **Custom scrollbar**: No grabbable vertical scrollbar with slow scroll
6. **Window close popup**: No hover-triggered close in tile corner

## Technical Decisions (CONFIRMED)

### 1. Folder Color Mapping

- **Hloubka**: 2-3 úrovně od home (např. `/home/user/projects/foo` = jedna barva)
- **Logika**: Hash folder path → index do GROUP_COLORS palety
- Terminály ve stejné "root složce" sdílí barvu

### 2. Dynamic Content Scaling

- **Metoda**: CSS `transform: scale()` na obsah okna
- **Rozsah**: cca 0.8 → 1.2 (vizuální zoom)
- Scaluje se dynamicky při resize okna

### 3. Custom Vertical Scrollbar

- **Typ**: Vlastní uchopitelný (grabbable) vertikální scrollbar
- Nahradí/překryje výchozí xterm scrollbar
- Vizuálně konzistentní s DeckTerm dark theme

### 4. Close Popup

- **Styl**: Inline tooltip s Yes/No tlačítky přímo u křížku
- Objeví se při hover v pravém horním rohu OKNA (tile), ne tabu
- Kompaktní, ne modal

### 5. Horizontal Workspace Scroll

- **Trigger**: Když okna jsou užší než MIN_WIDTH (250px) a nevejdou se
- Scrollbar se objeví automaticky
- Tiles přestanou používat % positioning když overflow

## Research Findings

- xterm.js has `scrollSensitivity` option for scroll speed
- CSS `scroll-behavior: smooth` can help with smooth scrolling
- CSS `transform: scale()` could handle content scaling
- Custom scrollbar: Need to overlay xterm viewport with custom thumb

## Open Questions (REMAINING)

1. ~~Color per folder path~~ ✅ 2-3 úrovně
2. Paleta barev - 7 současných stačí, nebo rozšířit?
3. ~~Dynamické škálování~~ ✅ CSS transform scale
4. ~~Slow scrolling~~ ✅ Custom grabbable scrollbar
5. ~~Confirmation dialog~~ ✅ Inline tooltip

## Scope Boundaries

- INCLUDE:
  - Folder-based tab/window coloring
  - Multi-color gradient for merged workspaces
  - CSS transform scaling on resize
  - Custom vertical scrollbar per tile
  - Horizontal scroll for overflow workspace
  - Hover close button with inline confirmation

- EXCLUDE: [pending - co explicitně NEdělat?]
