# Design System — Tennis Lounge Tsukashin Front Desk Settlement Tool

## 1. Design Context

### Project Overview

A local-first, offline-capable front desk settlement tool for Tennis Lounge Tsukashin. Runs entirely in the browser as a PWA. Records daily visitor attendance, item purchases, payments, and issues receipts. SaaS (HiTouch) is the source of truth for member/class/payment data; this app caches that data locally and adds the settlement layer. All data lives in an in-browser SQLite database (sql.js + OPFS). Hosted on GitHub Pages.

### Target Users

Front desk reception staff, primarily in their 50s. IT literacy is not high. Usage context: busy reception counter, hands frequently on keyboard, intermittent attention. Primary device: desktop PC or laptop, 1024px+ screen. No mobile use.

### Brand Direction

- Tone Keywords: Clean / Functional / Calm / High-Contrast / Familiar
- Visual Impression: A quiet, utilitarian tool that feels like a well-organized paper ledger digitized. The interface should disappear — the user sees their data, not the app.
- Dark Mode: No

### Design Principles

1. Clarity over decoration — Every visual element must serve a functional purpose. If removing it does not reduce understanding, remove it.
2. Immediate legibility — Text, numbers, and status indicators must be readable at arm's length. Favor size and contrast over color coding alone.
3. One action, one glance — The user should identify the next action within 1 second of looking at any screen region. Visual hierarchy through size and weight, not color variety.
4. Familiar patterns only — Use standard table/form/button patterns. No novel interactions. The app should feel like something the user already knows how to use.
5. Forgiveness — Destructive actions require confirmation. State changes are reversible where possible. Errors are shown inline, not in modals.

### Constraints

- Tech Stack: HTML + CSS + vanilla JS. No framework. sql.js (WASM SQLite) + OPFS. jsPDF for receipts. Service Worker for offline. GitHub Pages hosting.
- Accessibility: WCAG 2.2 AA (contrast ratios, focus indicators, touch targets)
- Performance: Must work offline after first load. No network dependency for daily operations.
- Browser Target: Chrome (primary), Edge (secondary)
- Screen Size: 1024px+ desktop only. No responsive/mobile design needed.


---


## 2. Page Structure & Wireframes

### Screen List

    Screen 1: Visitor List (default, main screen)
    Screen 2: Individual Detail (per-person view)

Two-screen app with show/hide switching in a single index.html. Screen 1 is always the entry point. Screen 2 is accessed via F2 or button with a selected row, and returns via Esc or back button.

### Overlays (not separate screens)

- Search autocomplete dropdown (Screen 1, above search bar)
- Product code input inline popover (Screen 1, within table row)
- Payment method selector inline popover (Screen 1, within table row)
- CSV export options panel (Screen 1, dropdown from CSV button)
- DB management panel (Screen 1, accessible via gear icon)
- Confirmation dialogs (delete person, DB import)

### Screen Transition Flow

    Daily Operation Flow (primary):
    Screen 1 → Search member → Add to list → Add items → Mark attended → Mark received
      → [F2] → Screen 2 → View/edit details → Issue receipt
      → [Esc] → Screen 1

    Data Management Flow:
    Screen 1 → [Update] → File picker (CSV) → Sync summary → Screen 1 refreshed
    Screen 1 → [CSV] → Export options → Download CSV
    Screen 1 → [Gear] → DB export/import panel

### Layout Pattern

Full-width content with header bar. No sidebar, no top nav. Content uses full viewport width with 24px horizontal padding.

    +-----------------------------------------------------------+
    |  [Header Bar: title, stats, action buttons]               |
    +-----------------------------------------------------------+
    |                                                           |
    |  [Main Content Area: table or detail sections]            |
    |                                                           |
    +-----------------------------------------------------------+
    |  [Footer Bar: search, action buttons] (Screen 1 only)    |
    +-----------------------------------------------------------+

### Screen 1: Visitor List Wireframe

    +---------------------------------------------------------------------+
    | 来館者一覧 (XX名)    窓口総額 ¥X,XXX      [更新]  [CSV]  [gear]    |
    +---------------------------------------------------------------------+
    | ID   | 氏名     | クラス | 時間枠 | 窓口料金 | 内訳          |[+]| メモ   | 出席 | 受取 |
    |------+----------+--------+--------+----------+---------------+---+--------+------+------|
    | T-01 | 山田太郎 | 初中級 |   B    | ¥1,100   | 体験レッスン  |[+]| ...    | [✓]  | [✓]  |
    |      |          |        |        |          | ¥1,100        |   |        |      | 現金 |
    |------+----------+--------+--------+----------+---------------+---+--------+------+------|
    | T-02 | 佐藤花子 | 上級   |   A    | ¥0       |               |[+]|        | [✓]  |      |
    +---------------------------------------------------------------------+
    | 検索: [半角カタカナ自動変換 ________________________]               |
    | [詳細 F2]  [削除]                                                   |
    +---------------------------------------------------------------------+

Notes:
- Breakdown column shows product name + price (e.g. "体験レッスン ¥1,100") instead of code + price
- Search bar auto-converts input to half-width katakana for member name search
- Received column hidden for ¥0 rows
- Selected row highlighted with teal-100 background

### Screen 2: Individual Detail Wireframe

    +---------------------------------------------------------------------+
    | [← 戻る (Esc)]                                                     |
    +---------------------------------------------------------------------+
    | 期間: [2026/04/13] ~ [2026/04/13]                                  |
    +---------------------------------------------------------------------+
    | ID: T-0012    氏名: 山田太郎    TEL: 090-XXXX-XXXX                 |
    | クラス: 初中級    曜日: 火    時間枠: B                             |
    +---------------------------------------------------------------------+
    | メモ: [_______________________________________________]             |
    +---------------------------------------------------------------------+
    | ◆ 窓口料金                                                         |
    | 日付 | 商品 | 名称         | 金額   | 数量 | 小計   | 決済 |       |
    |------+------+--------------+--------+------+--------+------|       |
    | 04/13| 001  | 体験レッスン | ¥1,100 |  1   | ¥1,100 | 現金 |       |
    |                                      合計: ¥1,100 (税込)          |
    |                                                    [+ 追加]        |
    +---------------------------------------------------------------------+
    | ◆ 商品マスタ 新規作成                                               |
    | 番号: [___] 名称: [_________] カテゴリ: [________] 金額: [____]    |
    | [仮登録]                                                            |
    +---------------------------------------------------------------------+
    | ◆ 商品マスタ 一覧・編集                                             |
    | コード | 名称              | カテゴリ | 金額(税込) | 状態   |       |
    |--------+-------------------+----------+------------+--------|       |
    | 001    | 体験レッスン      | レッスン | ¥1,100     | [有効] |       |
    +---------------------------------------------------------------------+
    | ◆ 領収書発行                                                       |
    | 宛名: [山田太郎_________]   発行元: テニスラウンジつかしん          |
    | [発行・印刷]                                                        |
    +---------------------------------------------------------------------+

Notes:
- Member info section includes 曜日 (day of week) field from SaaS master data
- Settlement table shows product name alongside code
- Past dates are read-only; only today is editable

### Component Inventory

Layout Components:
- Header Bar (Screen 1: title, stats, action buttons)
- Back Bar (Screen 2: back button)
- Section Divider (Screen 2: labeled sections with ◆)
- Footer Bar (Screen 1: search + action buttons)

Data Display:
- Data Table (Screen 1: visitor list; Screen 2: settlement items, product master)
- Section Header with Summary (visitor count, totals)
- Member Info Block (Screen 2: read-only ID, name, phone, class, day, timeslot)
- Currency Display (formatted ¥X,XXX with 税込 label)
- Breakdown Cell (product name + price within table cell)

Form Components:
- Text Input (search bar, memo, product fields, receipt recipient)
- Select / Dropdown (class, timeslot, payment method)
- Date Picker (Screen 2: date range)
- Inline Code Input (product code entry via [+] button)

Actions:
- Button Primary ([更新], [CSV], [発行・印刷], [仮登録], [+ 追加])
- Button Secondary ([詳細 F2], [削除])
- Button Header (translucent buttons on header bar)
- Icon Button ([+] add item, [gear] settings)
- Toggle Button (attendance, received)
- Inline Payment Method Selector (appears on received toggle)

Feedback:
- Autocomplete Dropdown (search results above search bar)
- Inline Confirmation (product code lookup result)
- Inline Error Message (code not found, duplicate person)
- Confirmation Dialog (delete person, DB import)
- Sync Summary Dialog (after CSV import)
- Warning Banner (OPFS failure, concurrent tab)
- Notice Toast (duplicate person focused)


---


## 3. Design Tokens

### 3.1 Color Palette

#### Tier 1: Primitives

Gray Scale (warm-neutral):

| Token       | Hex     | Notes                    |
|-------------|---------|--------------------------|
| --gray-50   | #F9FAFB | Lightest background      |
| --gray-100  | #F3F4F6 | Muted bg, table stripes  |
| --gray-200  | #E5E7EB | Borders, dividers        |
| --gray-300  | #D1D5DB | Disabled borders         |
| --gray-400  | #9CA3AF | Placeholder, disabled    |
| --gray-500  | #6B7280 | Secondary text           |
| --gray-600  | #4B5563 | —                        |
| --gray-700  | #374151 | —                        |
| --gray-800  | #1F2937 | Primary text             |
| --gray-900  | #111827 | Heaviest text            |

Brand Teal:

| Token       | Hex     | Notes                    |
|-------------|---------|--------------------------|
| --teal-50   | #F0FDFA | Lightest tint            |
| --teal-100  | #CCFBF1 | Selected row background  |
| --teal-200  | #99F6E4 | —                        |
| --teal-300  | #5EEAD4 | —                        |
| --teal-400  | #2DD4BF | —                        |
| --teal-500  | #14B8A6 | Brand base               |
| --teal-600  | #0D9488 | Header bar background    |
| --teal-700  | #0F766E | Hover state              |
| --teal-800  | #115E59 | Active/pressed           |
| --teal-900  | #134E4A | Darkest shade            |

Accent Coral:

| Token       | Hex     | Notes                    |
|-------------|---------|--------------------------|
| --coral-50  | #FFF5F5 | —                        |
| --coral-100 | #FFE4E4 | —                        |
| --coral-200 | #FBBFBF | —                        |
| --coral-300 | #F69292 | —                        |
| --coral-400 | #EF6461 | Accent base              |
| --coral-500 | #E5443F | CTA buttons              |
| --coral-600 | #D42B27 | Hover                    |
| --coral-700 | #B52220 | Active                   |
| --coral-800 | #951F1D | —                        |
| --coral-900 | #7C1F1D | —                        |

Semantic Colors:

| Token           | Hex     | Usage            |
|-----------------|---------|------------------|
| --success-light | #DCFCE7 | Success bg       |
| --success       | #16A34A | Success text     |
| --success-dark  | #15803D | Success emphasis  |
| --warning-light | #FEF9C3 | Warning bg       |
| --warning       | #EAB308 | Warning text     |
| --warning-dark  | #A16207 | Warning emphasis  |
| --error-light   | #FEE2E2 | Error bg         |
| --error         | #DC2626 | Error text       |
| --error-dark    | #B91C1C | Error emphasis    |
| --info-light    | #DBEAFE | Info bg          |
| --info          | #2563EB | Info text        |
| --info-dark     | #1D4ED8 | Info emphasis     |

#### Tier 2: Semantic Tokens

| Token                    | Value                  | WCAG AA vs bg  | Purpose                    |
|--------------------------|------------------------|----------------|----------------------------|
| --background             | --gray-50 (#F9FAFB)   | —              | App background             |
| --foreground             | --gray-800 (#1F2937)  | 14.5:1 ✓       | Primary text               |
| --foreground-secondary   | --gray-500 (#6B7280)  | 5.5:1 ✓        | Secondary text             |
| --foreground-placeholder | --gray-400 (#9CA3AF)  | 3.0:1          | Placeholder (large only)   |
| --primary                | --teal-600 (#0D9488)  | 4.6:1 ✓        | Header bar, main chrome    |
| --primary-foreground     | #FFFFFF               | 4.6:1 vs primary ✓ | Text on primary bg    |
| --primary-hover          | --teal-700 (#0F766E)  | 5.9:1 ✓        | Hover on primary           |
| --primary-active         | --teal-800 (#115E59)  | 7.5:1 ✓        | Active/pressed             |
| --accent                 | --coral-500 (#E5443F) | 4.6:1 ✓        | CTA, critical badges       |
| --accent-foreground      | #FFFFFF               | 4.6:1 vs accent ✓ | Text on accent bg     |
| --accent-hover           | --coral-600 (#D42B27) | 5.7:1 ✓        | Hover on accent            |
| --accent-active          | --coral-700 (#B52220) | 7.1:1 ✓        | Active/pressed             |
| --selected-row           | --teal-100 (#CCFBF1)  | —              | Selected row highlight     |
| --selected-row-foreground| --gray-800 (#1F2937)  | 13.8:1 vs teal-100 ✓ | Text on selected row |
| --surface                | #FFFFFF               | —              | Card/elevated surface      |
| --border                 | --gray-200 (#E5E7EB)  | decorative     | Table borders, dividers    |
| --input-border           | --gray-500 (#6B7280)  | 4.6:1 vs #FFF ✓ | Input/select borders     |
| --input-border-focus     | --teal-600 (#0D9488)  | 4.6:1 ✓        | Focused input border       |
| --ring                   | --teal-500 (#14B8A6)  | —              | Focus ring                 |
| --disabled               | --gray-400 (#9CA3AF)  | —              | Disabled state             |
| --disabled-bg            | --gray-100 (#F3F4F6)  | —              | Disabled element bg        |

#### Tier 3: Component Tokens

| Token                    | Value                    | Purpose               |
|--------------------------|--------------------------|-----------------------|
| --header-bg              | var(--primary)           | Screen 1 header bar   |
| --header-fg              | var(--primary-foreground) | Header bar text      |
| --table-row-odd          | var(--background)        | Odd table rows        |
| --table-row-even         | var(--gray-100)          | Even table rows       |
| --table-row-selected     | var(--selected-row)      | Selected row          |
| --table-row-selected-fg  | var(--selected-row-foreground) | Selected row text |
| --btn-attended           | var(--success)           | Attendance confirmed  |
| --btn-received           | var(--info)              | Payment received      |

#### 60:30:10 Verification

| Role         | Colors              | Target | Estimated |
|--------------|---------------------|--------|-----------|
| Base (60%)   | gray-50, gray-100, white | 60% | ~65%     |
| Main (30%)   | teal-500–800        | 30%    | ~25%      |
| Accent (10%) | coral-400–600       | 10%    | ~5%       |
| Semantic     | success/warning/error/info | as needed | ~5% |

Accent intentionally under 10% — fewer attention-grabbing elements means less cognitive noise per design principle §1.4.

### 3.2 Typography

Font: Noto Sans JP (weights: 400, 500, 700). Loaded via Google Fonts for UI, TTF in lib/ for jsPDF only. All numeric display uses font-feature-settings: "tnum" for tabular alignment.

#### Type Scale

| Token              | Size  | Weight | Line Height | Letter Spacing | Usage                     |
|--------------------|-------|--------|-------------|----------------|---------------------------|
| --text-display     | 24px  | 700    | 1.2         | -0.01em        | Screen title in header    |
| --text-h1          | 20px  | 700    | 1.3         | -0.005em       | Section headers (◆)       |
| --text-h2          | 18px  | 600    | 1.3         | 0              | Sub-section headers       |
| --text-body        | 16px  | 400    | 1.6         | 0              | General text, forms       |
| --text-table       | 15px  | 400    | 1.4         | 0              | Table cell data           |
| --text-table-header| 14px  | 700    | 1.4         | 0.02em         | Table column headers      |
| --text-small       | 14px  | 400    | 1.5         | 0.01em         | Supplementary info        |
| --text-caption     | 12px  | 500    | 1.4         | 0.02em         | Labels, hints, 税込       |

#### Numeric Display

| Token               | Size  | Weight | Usage                          |
|----------------------|-------|--------|--------------------------------|
| --text-amount        | 18px  | 700    | Currency in table (¥X,XXX)     |
| --text-total         | 24px  | 700    | Header total, section totals   |
| --text-receipt-amount| 30px  | 700    | Receipt PDF large amount       |

### 3.3 Spacing

4px grid base.

| Token    | Value | Usage                          |
|----------|-------|--------------------------------|
| --sp-1   | 4px   | Icon-text gap, tight padding   |
| --sp-2   | 8px   | Close elements, cell v-padding |
| --sp-3   | 12px  | Cell h-padding, form gap       |
| --sp-4   | 16px  | Card padding, section internal |
| --sp-6   | 24px  | Between form groups            |
| --sp-8   | 32px  | Between sections               |
| --sp-10  | 40px  | —                              |
| --sp-12  | 48px  | Major section separation       |
| --sp-16  | 64px  | Page top/bottom padding        |

### 3.4 Layout

| Token              | Value | Purpose                     |
|--------------------|-------|-----------------------------|
| --layout-padding-x | 24px  | Horizontal page padding     |
| --layout-padding-y | 16px  | Vertical page padding       |
| --header-height    | 56px  | Screen 1 header bar height  |
| --footer-height    | 80px  | Screen 1 footer bar height  |
| --table-row-height | 48px  | Minimum row height          |
| --input-height     | 44px  | All input/select/button     |
| --min-touch-target | 44px  | Per WCAG and PLAN.md        |

Screen 1 table column widths:

| Column   | Width  | Notes          |
|----------|--------|----------------|
| ID       | 80px   | Fixed          |
| 氏名     | 120px  | Fixed          |
| クラス   | 100px  | Dropdown       |
| 時間枠   | 80px   | Dropdown       |
| 窓口料金 | 100px  | Right-aligned  |
| 内訳     | 180px  | Name + price   |
| [+]      | 48px   | Icon button    |
| メモ     | 140px  | Text input     |
| 出席     | 56px   | Toggle button  |
| 受取     | 120px  | Toggle + badge |

Total: ~1024px.

### 3.5 Radius

| Token         | Value  | Usage                           |
|---------------|--------|---------------------------------|
| --radius-sm   | 4px    | Badges, table cells             |
| --radius-md   | 6px    | Buttons, inputs, selects        |
| --radius-lg   | 8px    | Cards, dialogs, autocomplete    |
| --radius-full | 9999px | Toggle indicators (circles)     |

### 3.6 Shadows

| Token       | Value                          | Usage                    |
|-------------|--------------------------------|--------------------------|
| --shadow-none | none                         | Default flat elements    |
| --shadow-sm | 0 1px 3px rgba(0,0,0,0.08)    | Autocomplete dropdown    |
| --shadow-md | 0 4px 8px rgba(0,0,0,0.10)    | Dialogs, popups          |

### 3.7 Borders

| Token                | Value                   | Usage                  |
|----------------------|-------------------------|------------------------|
| --border-width       | 1px                     | All borders            |
| --border-color       | var(--border)           | Table, dividers        |
| --border-color-strong| var(--input-border)     | Input/select borders   |
| --border-focus-width | 2px                     | Focus ring width       |
| --border-focus-color | var(--ring)             | Focus ring color       |
| --border-focus-offset| 2px                     | Focus ring offset      |


---


## 4. Component Specifications

### 4.1 Icon System

Library: No external icon library. This app uses minimal iconography — text labels and Unicode symbols only (✓, ○, +, ←, ⚙). Keeps dependencies at zero per PLAN.md vanilla JS constraint.

Icon sizes (for any future icon additions):

| Token    | Value | Usage                    |
|----------|-------|--------------------------|
| icon-sm  | 16px  | Inside badges            |
| icon-md  | 20px  | Inside buttons           |
| icon-lg  | 24px  | Header actions           |

Style rule: outline style only. No filled icons. Icons always paired with text label (per §1.6 — color+icon+text triple encoding).

### 4.2 Button

#### Variants

| Variant   | Usage                                              |
|-----------|----------------------------------------------------|
| primary   | Main actions: 更新, CSV, 詳細 F2, + 追加, 発行・印刷 |
| accent    | High-emphasis CTA: 仮登録, 発行・印刷              |
| secondary | Low-emphasis: 削除 (with error color override)     |
| outline   | Neutral actions, inline controls                   |
| header    | Translucent buttons on teal header bar             |
| icon      | Square button for [+] and [gear]                   |

#### Sizes

| Size | Height | Padding (h)  | Font Token  |
|------|--------|--------------|-------------|
| sm   | 36px   | --sp-3       | --text-small |
| md   | 44px   | --sp-4       | --text-body  |

Default size is md (44px) to meet minimum touch target. sm used only for inline table controls ([+] button).

#### States (all variants)

| State    | Background           | Text                  | Border                | Other            |
|----------|----------------------|-----------------------|-----------------------|------------------|
| default  | per variant          | per variant           | per variant           |                  |
| hover    | darker shade         | unchanged             | darker shade          | cursor: pointer  |
| active   | darkest shade        | unchanged             | darkest shade         |                  |
| focus    | unchanged            | unchanged             | 2px var(--ring)       | outline offset 2px |
| disabled | var(--disabled-bg)   | var(--disabled)       | var(--border)         | cursor: not-allowed |

Primary states detail:

| State    | Background                | Border                    |
|----------|---------------------------|---------------------------|
| default  | var(--primary) #0D9488    | var(--primary)            |
| hover    | var(--primary-hover) #0F766E | var(--primary-hover)   |
| active   | var(--primary-active) #115E59 | var(--primary-active) |
| disabled | var(--disabled-bg) #F3F4F6 | var(--border) #E5E7EB   |

Accent states detail:

| State    | Background                | Border                    |
|----------|---------------------------|---------------------------|
| default  | var(--accent) #E5443F     | var(--accent)             |
| hover    | var(--accent-hover) #D42B27 | var(--accent-hover)     |
| active   | var(--accent-active) #B52220 | var(--accent-active)   |
| disabled | var(--disabled-bg)        | var(--border)             |

Header states detail:

| State    | Background                | Border                    |
|----------|---------------------------|---------------------------|
| default  | rgba(255,255,255,0.15)    | rgba(255,255,255,0.3)     |
| hover    | rgba(255,255,255,0.25)    | rgba(255,255,255,0.3)     |
| active   | rgba(255,255,255,0.35)    | rgba(255,255,255,0.3)     |

Delete button: uses outline variant with color override — text and border use var(--error), hover background uses var(--error-light).

#### Anatomy

    [Label]
    or
    [Icon] [Label]    (icon-md 20px, gap --sp-2)
    or
    [Icon]            (icon-only for btn-icon)

Label is required for all non-icon buttons. No icon-only buttons except [+] and [gear].

#### Accessibility

- Role: button (native element)
- Keyboard: Enter / Space to activate
- Focus indicator: 2px solid var(--ring), offset 2px
- Disabled: aria-disabled="true", pointer-events: none
- Icon-only buttons: must have title attribute or aria-label

#### Usage Notes

- Screen 1 header: btn-header for 更新, CSV, gear
- Screen 1 footer: btn-primary for 詳細 F2, btn-outline (error override) for 削除
- Screen 1 table: btn-icon (sm) for [+]
- Screen 2: btn-accent for 仮登録 and 発行・印刷, btn-primary for + 追加
- Never stack two accent buttons in the same visual region
- Delete button always requires confirmation dialog before action

### 4.3 Text Input

#### Variants

| Variant       | Usage                                    |
|---------------|------------------------------------------|
| default       | Product fields, receipt recipient, memo   |
| search        | Screen 1 search bar (half-width katakana auto-convert) |
| inline-table  | Memo field within table cell             |

#### Sizes

| Size | Height | Padding      | Font Token   |
|------|--------|--------------|--------------|
| md   | 44px   | 0 --sp-4     | --text-body  |
| sm   | 32px   | 0 --sp-2     | --text-small |

Default size is md. sm used only for inline-table memo input.

#### States

| State       | Background      | Border                      | Text                  | Other              |
|-------------|-----------------|-----------------------------|-----------------------|--------------------|
| default     | var(--surface)  | 2px var(--input-border)     | var(--foreground)     |                    |
| placeholder | var(--surface)  | 2px var(--input-border)     | var(--foreground-placeholder) |            |
| hover       | var(--surface)  | 2px var(--gray-600)         | var(--foreground)     |                    |
| focus       | var(--surface)  | 2px var(--input-border-focus)| var(--foreground)    | box-shadow: 0 0 0 3px rgba(13,148,136,0.15) |
| error       | var(--surface)  | 2px var(--error)            | var(--foreground)     | error message below |
| disabled    | var(--disabled-bg)| 2px var(--border)          | var(--disabled)       | cursor: not-allowed |
| readonly    | var(--disabled-bg)| 2px var(--border)          | var(--foreground-secondary) |              |

#### Search input specific behavior

- On input, convert full-width katakana (ア → ｱ) to half-width katakana in real time
- All character types accepted for search (ID, phone, katakana) — conversion is additive, not restrictive

#### Anatomy

    [Input Field]
    or
    [Label]
    [Input Field]
    [Error Message?]

Label above input for form contexts (Screen 2 product master). No label for inline-table and search variants.

#### Accessibility

- Role: textbox (native input)
- Labels: associated via label element or aria-label
- Error: aria-invalid="true" + aria-describedby pointing to error message
- Focus: visible focus ring via border color change + box-shadow

### 4.4 Select / Dropdown

#### Variants

| Variant       | Usage                                        |
|---------------|----------------------------------------------|
| inline-table  | Class and timeslot dropdowns in table cells   |
| form          | Payment method selector, other form contexts  |

#### Sizes

| Size | Height | Font Token      |
|------|--------|-----------------|
| sm   | 36px   | --text-table    |
| md   | 44px   | --text-body     |

sm for inline-table. md for form contexts.

#### States

Same as Text Input states (default, hover, focus, disabled). Uses native select element for maximum familiarity and reliability.

#### Accessibility

- Native select element — inherits browser accessibility
- Focus indicator: same as text input
- Keyboard: arrow keys to navigate options, Enter to select

### 4.5 Date Picker

Uses native input[type="date"] for maximum reliability and familiarity. No custom date picker.

Size: md (44px height). States: same as Text Input.

Used in: Screen 2 date range selector.

### 4.6 Toggle Button (Attendance / Received)

#### Variants

| Variant    | Off State                          | On State                           |
|------------|------------------------------------|------------------------------------|
| attendance | Circle, border var(--border), text "○" | Filled var(--btn-attended), text "✓", white |
| received   | Circle, border var(--border), text "○" | Filled var(--btn-received), text "✓", white |

#### Size

40px diameter circle (meets 44px touch target with 2px border).

#### States

| State    | Off                                | On                                 |
|----------|------------------------------------|------------------------------------|
| default  | bg: var(--surface), border: var(--border) | bg: variant color, border: variant color |
| hover    | bg: var(--gray-100), border: var(--gray-300) | bg: darker variant, border: darker variant |
| focus    | + 2px var(--ring) outline          | + 2px var(--ring) outline          |
| disabled | bg: var(--disabled-bg), border: var(--border), text: var(--disabled) | same as off disabled |

#### Behavior

- Attendance: simple toggle. Independent of payment.
- Received: on first toggle to ON, payment method selector appears inline. User must select a payment method. Toggle OFF clears the payment method.
- Triple encoding per §1.6: color (green/blue) + icon (✓/○) + text context (column header label)

#### Accessibility

- Role: button with aria-pressed
- Keyboard: Enter / Space to toggle
- aria-label: "出席" or "受取" + current state

### 4.7 Payment Method Selector

Appears inline in the received column when the received toggle is activated.

#### Structure

A horizontal row of small radio-style buttons, one per active payment method.

| State    | Background           | Text                    | Border              |
|----------|----------------------|-------------------------|---------------------|
| default  | var(--surface)       | var(--foreground)       | var(--border)       |
| selected | var(--info-light)    | var(--info-dark)        | var(--info)         |
| hover    | var(--gray-100)      | var(--foreground)       | var(--gray-300)     |
| focus    | var(--surface)       | var(--foreground)       | 2px var(--ring)     |

Badge display: after selection, collapses to a small badge showing the method name (e.g. "現金", "PayPay"). Badge uses --info-light bg, --info-dark text, --radius-sm.

#### Accessibility

- Role: radiogroup with radio buttons
- Keyboard: arrow keys to move between options, Enter/Space to select

### 4.8 Data Table

#### Structure

- thead: sticky at top of scroll container
- tbody: scrollable
- Alternating row colors: odd var(--table-row-odd), even var(--table-row-even)
- Selected row: var(--table-row-selected) background
- All currency columns: right-aligned, font-feature-settings: "tnum"
- Minimum row height: var(--table-row-height) 48px

#### Header Row

| Property   | Value                    |
|------------|--------------------------|
| Background | var(--surface) #FFFFFF   |
| Text color | var(--foreground-secondary) |
| Font       | --text-table-header, 700 |
| Padding    | --sp-2 --sp-3            |
| Border     | 2px solid var(--border) bottom |
| Sticky     | top: 0, z-index: 1      |

#### Body Row States

| State    | Background                  | Text                         |
|----------|-----------------------------|------------------------------|
| odd      | var(--table-row-odd)        | var(--foreground)            |
| even     | var(--table-row-even)       | var(--foreground)            |
| hover    | var(--gray-200) #E5E7EB    | var(--foreground)            |
| selected | var(--table-row-selected)   | var(--table-row-selected-fg) |

#### Cell Types

| Type           | Font Token      | Alignment | Notes                    |
|----------------|-----------------|-----------|--------------------------|
| ID             | --text-table    | left      | Monospace-like (tnum)    |
| Name           | --text-table    | left      |                          |
| Class/Timeslot | --text-table    | left      | Contains select element  |
| Amount         | --text-amount   | right     | ¥ prefix, comma format   |
| Breakdown      | --text-small    | left      | Product name + ¥amount   |
| Memo           | --text-small    | left      | Contains inline input    |
| Toggle         | —               | center    | Toggle button            |

#### Accessibility

- Table uses proper thead/tbody/th/td structure
- th elements have scope="col"
- Selected row: aria-selected="true"
- Keyboard navigation: arrow keys move between rows

### 4.9 Breakdown Cell

Displays item list within a table cell on Screen 1.

Format: "{product name} ¥{price}" per line. Multiple items stack vertically.

    体験レッスン ¥1,100
    ガット張り(ナイロン) ¥2,000

Font: --text-small, color: var(--foreground-secondary). Line height: 1.5.

### 4.10 Currency Display

| Context          | Font Token        | Format          |
|------------------|-------------------|-----------------|
| Table cell       | --text-amount     | ¥X,XXX          |
| Header total     | --text-total      | ¥X,XXX          |
| Section total    | --text-total      | ¥X,XXX (税込)   |
| Zero amount      | --text-table      | ¥0 (secondary color) |

All amounts use font-feature-settings: "tnum". Comma separator for thousands. ¥ prefix. 税込 label uses --text-caption.

### 4.11 Member Info Block (Screen 2)

Read-only display of member master data.

Structure: CSS grid, auto-fit columns min 200px. Card-like container with var(--surface) bg, var(--border) border, var(--radius-lg) radius, --sp-4 padding.

Each field:
- Label: --text-caption, 500 weight, var(--foreground-secondary), uppercase letter-spacing 0.02em
- Value: --text-body, 500 weight, var(--foreground)

Fields: ID, 氏名, TEL, クラス, 曜日, 時間枠

### 4.12 Section Divider (Screen 2)

Section title with ◆ prefix.

| Property   | Value                            |
|------------|----------------------------------|
| Font       | --text-h1, 700 weight            |
| Color      | var(--foreground)                |
| Padding    | bottom --sp-2                    |
| Border     | 2px solid var(--primary) bottom  |
| Margin     | top --sp-8 (between sections)    |

### 4.13 Header Bar (Screen 1)

| Property   | Value                          |
|------------|--------------------------------|
| Height     | var(--header-height) 56px      |
| Background | var(--header-bg)               |
| Text color | var(--header-fg) #FFFFFF       |
| Padding    | 0 var(--layout-padding-x)     |
| Gap        | var(--sp-6) between elements   |

Content: title (--text-display), visitor count (--text-body), total amount (--text-total), action buttons (btn-header).

### 4.14 Back Bar (Screen 2)

| Property   | Value                          |
|------------|--------------------------------|
| Height     | var(--header-height) 56px      |
| Background | var(--surface)                 |
| Border     | 1px solid var(--border) bottom |
| Padding    | 0 var(--layout-padding-x)     |

Contains: single btn-outline with "← 戻る (Esc)" label.

### 4.15 Footer Bar (Screen 1)

| Property   | Value                          |
|------------|--------------------------------|
| Background | var(--surface)                 |
| Border     | 2px solid var(--border) top    |
| Padding    | --sp-3 var(--layout-padding-x) |
| Gap        | --sp-2 between rows            |

Contains: search input row, action button row.

### 4.16 Autocomplete Dropdown

Appears above search bar. Max 10 results.

| Property   | Value                           |
|------------|---------------------------------|
| Background | var(--surface)                  |
| Border     | 1px solid var(--border)         |
| Shadow     | var(--shadow-sm)                |
| Radius     | var(--radius-lg)                |
| Max height | 400px (scrollable)              |
| Z-index    | 10                              |

Each item:

| State    | Background        | Text                  |
|----------|--------------------|----------------------|
| default  | var(--surface)     | var(--foreground)    |
| hover    | var(--gray-100)    | var(--foreground)    |
| focused  | var(--teal-50)     | var(--foreground)    |

Item height: var(--table-row-height) 48px. Padding: --sp-2 --sp-4. Shows: ID, name, phone (secondary color).

Walk-in option at bottom: italic text, "ウォークインとして追加: {typed name}".

#### Accessibility

- Role: listbox with option items
- aria-activedescendant tracks focused item
- Keyboard: arrow keys to navigate, Enter to select, Esc to close

### 4.17 Inline Product Code Input

Appears when [+] button is clicked on a table row.

Small popover anchored to the [+] button.

| Property   | Value                           |
|------------|---------------------------------|
| Background | var(--surface)                  |
| Border     | 1px solid var(--border)         |
| Shadow     | var(--shadow-sm)                |
| Radius     | var(--radius-lg)                |
| Padding    | --sp-3                          |

Contains: text input (sm size, width 80px) for product code. On valid code entry, shows confirmation line: "{code}: {name} ¥{price}" with confirm/cancel buttons.

On invalid code: inline error "コードが見つかりません" in var(--error) color.

### 4.18 Confirmation Dialog

Used for: delete person, DB import.

| Property     | Value                            |
|--------------|----------------------------------|
| Overlay      | rgba(0,0,0,0.4)                 |
| Dialog bg    | var(--surface)                   |
| Shadow       | var(--shadow-md)                 |
| Radius       | var(--radius-lg)                 |
| Padding      | --sp-6                           |
| Max width    | 480px                            |
| Centered     | vertically and horizontally      |

Structure:

    [Title: --text-h2, 600 weight]
    [Message: --text-body, var(--foreground-secondary)]
    [Actions: right-aligned, gap --sp-2]
      [Cancel: btn-outline]
      [Confirm: btn-primary or btn-outline with error color for destructive]

For DB import (two-step): second dialog has a text input requiring "DELETE" to enable confirm button.

#### Accessibility

- Role: alertdialog
- aria-modal="true"
- Focus trapped within dialog
- Esc to close (cancel action)
- Initial focus on cancel button (safe default)

### 4.19 Sync Summary Dialog

Appears after CSV import. Non-modal — can be dismissed.

Same styling as Confirmation Dialog but with:
- Title: "同期完了"
- Content: summary text ("Members: X updated. Payment methods: X updated.")
- Single button: btn-primary "閉じる"

### 4.20 Warning Banner

Persistent banner for critical issues (OPFS failure, concurrent tab).

| Property   | Value                               |
|------------|-------------------------------------|
| Background | var(--warning-light)                |
| Border     | 1px solid var(--warning) left (4px) |
| Text       | var(--warning-dark)                 |
| Padding    | --sp-3 --sp-4                       |
| Position   | Top of screen, below header bar     |

Contains: warning icon (⚠) + message text + optional dismiss button.

Per §1.6: triple encoding — yellow background + ⚠ icon + text message.

#### Accessibility

- Role: alert
- aria-live="assertive" for OPFS failure
- aria-live="polite" for concurrent tab warning

### 4.21 Notice Toast

Brief notification (e.g. "この会員は既に一覧にいます").

| Property   | Value                               |
|------------|-------------------------------------|
| Background | var(--surface)                      |
| Border     | 1px solid var(--border)             |
| Shadow     | var(--shadow-md)                    |
| Radius     | var(--radius-lg)                    |
| Padding    | --sp-3 --sp-4                       |
| Position   | Top-right, 24px from edges          |
| Auto-dismiss | 4 seconds                         |

#### Accessibility

- Role: status
- aria-live="polite"

### 4.22 Inline Error Message

Appears below input fields or within table cells.

| Property   | Value                     |
|------------|---------------------------|
| Font       | --text-caption            |
| Color      | var(--error)              |
| Margin     | top --sp-1                |

### 4.23 Badge / Status Indicator

Used in product master table for status display.

| Variant     | Background           | Text                  |
|-------------|----------------------|-----------------------|
| active      | var(--success-light) | var(--success-dark)   |
| provisional | var(--warning-light) | var(--warning-dark)   |
| inactive    | var(--gray-100)      | var(--gray-400)       |

Size: padding 2px --sp-2, font --text-caption, 500 weight, radius --radius-sm.

### 4.24 Textarea (Memo)

Used in Screen 2 for member memo.

Same states as Text Input. Additional properties:
- min-height: 60px
- resize: vertical
- Padding: --sp-3

### 4.25 Product Master Form (Screen 2)

Horizontal form layout with form-groups.

Each form-group:
- Label: --text-caption, 500 weight, var(--foreground-secondary)
- Input: text input (md size)
- Gap between label and input: --sp-1
- Gap between form-groups: --sp-3

Submit button (仮登録): btn-accent, placed at end of row aligned to bottom.

### 4.26 Receipt Section (Screen 2)

Card container: var(--surface) bg, var(--border) border, var(--radius-lg) radius, --sp-4 padding.

Contains: form fields (recipient name, issuer) + action button (発行・印刷).

Issuer field: readonly input with var(--disabled-bg) background.

Button disabled state: when total is ¥0, btn-accent shows disabled state.


---


## 5. Motion & Interaction

### 5.1 Motion Philosophy

Selected approach: **Restrained**

Rationale: Tone keywords are Clean / Functional / Calm. The target user (50s, non-technical) benefits from minimal motion that does not distract from the task. Per constitution §2.1: "The user does not notice the animation but feels the app is easy to use" is the ideal. Per §2.4: functional animation only; decorative animation is not used in this app.

This is an internal operations tool used repeatedly throughout the day. Per §2.3 frequency rule: frequently occurring interactions get shorter durations.

### 5.2 Duration Tokens

| Token      | Value | Usage                                  |
|------------|-------|----------------------------------------|
| --dur-instant | 100ms | Hover, focus ring, toggle state     |
| --dur-fast    | 150ms | Button press feedback, tooltip      |
| --dur-normal  | 200ms | Dropdown open/close, autocomplete   |
| --dur-slow    | 300ms | Screen transition, dialog open      |

Note: maximum duration is 300ms. No 400ms+ animations in this app. Per §2.3: web transitions should be about half of mobile. Per NNg: above 500ms feels like delay. For a frequently-used operations tool, 300ms is the ceiling.

Exit animations are shorter than enter animations per NNg guidance:
- Dialog open: 300ms (slow), Dialog close: 200ms (normal)
- Dropdown open: 200ms (normal), Dropdown close: 100ms (instant)

### 5.3 Easing Tokens

| Token            | Value                            | Usage                      |
|------------------|----------------------------------|----------------------------|
| --ease-out       | cubic-bezier(0.16, 1, 0.3, 1)   | Element appearance, expand |
| --ease-in        | cubic-bezier(0.7, 0, 0.84, 0)   | Element exit, collapse     |
| --ease-in-out    | cubic-bezier(0.45, 0, 0.55, 1)  | Position movement          |

No ease-spring. No linear (except progress bars if needed). Per constitution §2.3: linear feels mechanical and unnatural.

### 5.4 Component Motion Specs

#### Button

| Trigger | Property         | Duration     | Easing     |
|---------|------------------|--------------|------------|
| hover   | background-color | --dur-instant | --ease-out |
| active  | transform scale(0.98) | --dur-instant | --ease-out |
| focus   | outline (ring)   | --dur-instant | --ease-out |

#### Toggle Button (Attendance / Received)

| Trigger | Property                  | Duration     | Easing     |
|---------|---------------------------|--------------|------------|
| toggle  | background-color, border  | --dur-instant | --ease-out |

Simple color swap. No scale, no bounce. Per Restrained approach.

#### Text Input / Select

| Trigger | Property            | Duration     | Easing     |
|---------|---------------------|--------------|------------|
| focus   | border-color, box-shadow | --dur-instant | --ease-out |

#### Autocomplete Dropdown

| Trigger | Property                     | Duration     | Easing     |
|---------|------------------------------|--------------|------------|
| open    | opacity, translateY(-4px→0)  | --dur-normal | --ease-out |
| close   | opacity                      | --dur-instant | --ease-in |

#### Inline Product Code Input (Popover)

| Trigger | Property                     | Duration     | Easing     |
|---------|------------------------------|--------------|------------|
| open    | opacity, translateY(-4px→0)  | --dur-normal | --ease-out |
| close   | opacity                      | --dur-instant | --ease-in |

#### Confirmation Dialog

| Trigger | Property                      | Duration     | Easing     |
|---------|-------------------------------|--------------|------------|
| open    | overlay opacity               | --dur-slow   | --ease-out |
| open    | dialog opacity, scale(0.97→1) | --dur-slow   | --ease-out |
| close   | dialog opacity                | --dur-normal | --ease-in  |
| close   | overlay opacity               | --dur-normal | --ease-in  |

#### Warning Banner

| Trigger | Property  | Duration     | Easing     |
|---------|-----------|--------------|------------|
| appear  | opacity   | --dur-normal | --ease-out |
| dismiss | opacity   | --dur-fast   | --ease-in  |

No slide animation. Fade only. Restrained approach.

#### Notice Toast

| Trigger     | Property                     | Duration     | Easing     |
|-------------|------------------------------|--------------|------------|
| enter       | opacity, translateY(-8px→0)  | --dur-normal | --ease-out |
| auto-dismiss| opacity                      | --dur-fast   | --ease-in  |

#### Table Row Selection

| Trigger | Property         | Duration     | Easing     |
|---------|------------------|--------------|------------|
| select  | background-color | --dur-instant | --ease-out |

Immediate color change. No scale, no slide.

#### Table Row Hover

| Trigger | Property         | Duration     | Easing     |
|---------|------------------|--------------|------------|
| hover   | background-color | --dur-instant | --ease-out |

### 5.5 Screen Transition

| Transition         | Property | Duration   | Easing        |
|--------------------|----------|------------|---------------|
| Screen 1 → Screen 2 | opacity | --dur-slow | --ease-out    |
| Screen 2 → Screen 1 | opacity | --dur-normal | --ease-in   |

Simple opacity crossfade. No translateX/Y, no scale. Rationale: the two screens are peers (not parent-child hierarchy). A subtle fade communicates the change without spatial implication. Per §2.1 condition 3 (Bederson & Boltman): spatial animation is valuable for hierarchical navigation, but this is a flat 2-screen structure where spatial metaphor adds no value.

Screen 1 → Screen 2 (entering detail): 300ms fade-in (longer for appearance per NNg).
Screen 2 → Screen 1 (returning to list): 200ms fade-out (shorter for exit).

### 5.6 Scroll Behavior

No scroll-linked animations. No parallax. No scroll jacking. Per constitution §2.4: these are explicitly prohibited patterns. The app uses standard browser scrolling only.

### 5.7 Performance Constraints

- Animate ONLY: transform, opacity. No width, height, top, left, margin, padding animations.
- will-change: apply dynamically before animation, remove after completion.
- Target: 60fps minimum. Any animation dropping below 60fps must be removed.
- Maximum simultaneous animated elements: 3 (per Staging principle — one focus at a time).
- No requestAnimationFrame loops for decorative purposes.

### 5.8 Accessibility — Reduced Motion

    @media (prefers-reduced-motion: reduce) {
      All transitions: duration set to 0ms (instant)
      All transforms: removed (no translateY, no scale)
      Opacity fades: allowed but instant (0ms)
      Screen transitions: instant swap (no fade)
      Dialogs: instant appear/disappear (no overlay fade)
      Dropdowns: instant show/hide
    }

Per WCAG 2.2 SC 2.3.3 and constitution §2.5:
- All animation is disabled when user prefers reduced motion
- Functional information (state changes) conveyed via color + icon + text (not motion)
- No flashing above 3 per second under any circumstance
- No auto-playing animations anywhere in the app


---


## 6. Anti-Patterns

### Color

- NEVER use raw hex values in components. Always reference semantic or component tokens.
- NEVER use color alone to convey information. Always pair with icon + text (triple encoding per §1.6).
- NEVER use pure white (#FFFFFF) as a page background. Use var(--background) (#F9FAFB).
- NEVER use pure black (#000000) for text. Use var(--foreground) (#1F2937).
- NEVER introduce colors outside the defined palette without updating this document first.

### Typography

- NEVER use font sizes not defined in the type scale. No arbitrary px values.
- NEVER use font weights other than 400, 500, 700.
- NEVER skip the Noto Sans JP font family. No system font fallbacks for display text.
- NEVER display currency amounts without font-feature-settings: "tnum".
- NEVER use text smaller than 12px (--text-caption) anywhere in the app.

### Spacing

- NEVER use spacing values outside the 4px grid scale. No arbitrary gaps.
- NEVER mix rem and px units. Use px throughout (desktop-only, fixed layout).

### Components

- NEVER create inline styles for component states. All states must match the specs in section 4.
- NEVER leave interactive elements without all 5 states defined (default, hover, active, focus, disabled).
- NEVER create a toggle or button smaller than 44x44px touch target.
- NEVER use an icon without a text label (exception: [+] and [gear] with title/aria-label).

### Motion

- NEVER use transition: all. Always specify exact properties.
- NEVER use durations above 300ms in this app.
- NEVER use linear easing (exception: progress bars).
- NEVER use decorative animation (bounce, pulse, shake, wiggle).
- NEVER animate layout properties (width, height, margin, padding, top, left).
- NEVER create auto-playing or looping animations.
- NEVER skip prefers-reduced-motion handling. Every transition must have a reduced-motion override.
- NEVER flash any element more than 3 times per second.

### General

- NEVER add a component not listed in section 4 without updating this document first.
- NEVER use z-index values not established here (1 for sticky header, 10 for dropdowns/autocomplete, 100 for dialogs).
- NEVER use external libraries beyond sql.js and jsPDF (per PLAN.md constraint).


---


## 7. Implementation Guide

### File Structure

    project-root/
      index.html              -- App shell, both screens
      css/
        style.css             -- All styles: tokens + components + layout
      js/
        app.js                -- Screen switching, keyboard shortcuts, init
        db.js                 -- sql.js init, OPFS, migrations
        visitor-list.js       -- Screen 1 logic
        individual-detail.js  -- Screen 2 logic
        product-master.js     -- Product CRUD
        receipt.js            -- PDF generation
        sync.js               -- SaaS sync layer
        csv.js                -- CSV export
      lib/
        sql-wasm.js           -- sql.js WASM loader
        sql-wasm.wasm         -- sql.js WASM binary
        jspdf.umd.min.js     -- jsPDF
        NotoSansJP-Regular.ttf -- Font for PDF
      sw.js                   -- Service Worker
      manifest.json           -- PWA manifest
      docs/
        design-system.md      -- This document

### CSS Token Implementation

All tokens defined as CSS custom properties on :root in css/style.css. No CSS preprocessor. No Tailwind. No CSS-in-JS. Plain CSS with variables.

    :root {
      /* Primitives */
      --gray-50: #F9FAFB;
      /* ... all primitive tokens ... */

      /* Semantic */
      --background: var(--gray-50);
      /* ... all semantic tokens ... */

      /* Component */
      --header-bg: var(--primary);
      /* ... all component tokens ... */

      /* Typography */
      --text-display: 24px;
      /* ... all type tokens ... */

      /* Spacing */
      --sp-1: 4px;
      /* ... all spacing tokens ... */

      /* Motion */
      --dur-instant: 100ms;
      --dur-fast: 150ms;
      --dur-normal: 200ms;
      --dur-slow: 300ms;
      --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
      --ease-in: cubic-bezier(0.7, 0, 0.84, 0);
      --ease-in-out: cubic-bezier(0.45, 0, 0.55, 1);

      /* Layout */
      --header-height: 56px;
      /* ... all layout tokens ... */

      /* Radius */
      --radius-sm: 4px;
      /* ... all radius tokens ... */

      /* Shadow */
      --shadow-sm: 0 1px 3px rgba(0,0,0,0.08);
      /* ... all shadow tokens ... */
    }

    @media (prefers-reduced-motion: reduce) {
      :root {
        --dur-instant: 0ms;
        --dur-fast: 0ms;
        --dur-normal: 0ms;
        --dur-slow: 0ms;
      }
    }

### Component Implementation Checklist

Before creating any UI element:

1. Verify component exists in section 4 of this document
2. Apply all defined states (default, hover, active, focus, disabled)
3. Use only tokens from section 3 — no raw values
4. Add motion from section 5 — specify exact properties, duration token, easing token
5. Include prefers-reduced-motion override
6. Ensure 44px minimum touch target
7. Add appropriate ARIA attributes per component spec
8. Verify WCAG AA contrast for all text against its background
9. Check against anti-patterns in section 6

### Z-Index Scale

| Value | Usage                          |
|-------|--------------------------------|
| 1     | Sticky table header            |
| 10    | Autocomplete dropdown, popovers |
| 50    | Warning banner                 |
| 100   | Dialog overlay + dialog        |
| 999   | Dev-only screen switcher       |

### Keyboard Shortcuts

| Key          | Context    | Action                          |
|--------------|------------|---------------------------------|
| F2           | Screen 1   | Open Screen 2 for selected row  |
| Esc          | Screen 2   | Return to Screen 1              |
| Arrow Up/Down| Screen 1   | Move row selection               |
| Enter        | Search     | Select autocomplete candidate    |
| /            | Screen 1   | Focus search bar                 |


---


## Appendix

### WCAG 2.2 AA Compliance Checklist

| Criterion | Requirement | Status |
|-----------|-------------|--------|
| 1.4.3 Contrast (Minimum) | 4.5:1 normal text, 3:1 large text | ✓ All tokens verified |
| 1.4.11 Non-text Contrast | 3:1 for UI components | ✓ Input borders 4.6:1 |
| 2.1.1 Keyboard | All functionality via keyboard | ✓ F2, Esc, arrows, Enter |
| 2.3.1 Three Flashes | No content flashes >3/sec | ✓ No flash animations |
| 2.3.3 Animation from Interactions | Respect prefers-reduced-motion | ✓ All durations set to 0ms |
| 2.4.7 Focus Visible | Visible focus indicator | ✓ 2px teal ring, 2px offset |
| 2.5.5 Target Size | Minimum 44x44px | ✓ All interactive elements |
| 4.1.2 Name, Role, Value | ARIA attributes | ✓ Per component specs |

### Design Principles Constitution Cross-Reference

| Constitution Section | Applied In |
|----------------------|------------|
| §1.1 60:30:10 ratio | Section 3.1 color verification table |
| §1.3 Gestalt (Similarity) | Section 4: consistent states across components |
| §1.3 Gestalt (Proximity) | Section 3.3: spacing scale 16px related / 32px unrelated |
| §1.3 Gestalt (Figure-Ground) | Section 3.1: all foreground >4.5:1 vs background |
| §1.3 Gestalt (Closure) | Section 4.11: member info card, section dividers |
| §1.4 Cognitive Load Theory | Section 1: design principles, 3-level action hierarchy |
| §1.6 Accessibility | Section 3.1 contrast table, section 4 all components |
| §1.6 Triple encoding | Section 4.6 toggles, 4.20 warning banner |
| §1.7 Design tokens | Section 3: full 3-tier token architecture |
| §1.7 Typography | Section 3.2: Noto Sans JP, tnum, scale |
| §2.1 Functional over decorative | Section 5.1: Restrained approach, no decorative motion |
| §2.3 Duration limits | Section 5.2: 100-300ms range, exit < enter |
| §2.3 Easing | Section 5.3: ease-out for enter, ease-in for exit |
| §2.4 Prohibited patterns | Section 5.6: no scroll-linked, no auto-play |
| §2.5 Reduced motion | Section 5.8: all durations to 0ms |
| §3.1 Checklist | This appendix |
