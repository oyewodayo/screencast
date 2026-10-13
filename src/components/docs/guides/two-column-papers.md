# Writing a two-column paper

This guide builds a journal-style paper in Docs from a blank page: two columns of typeset text, a title block across the full width, numbered equations, ruled tables, figures with captions, and live citations and references. It's the same kind of document Docs produces when you import a paper with **Import PDF**, so you can also use it to understand and edit an imported paper.

Every setting here can be changed at any time. Nothing is locked in by the order you do things.

This guide is also inside Docs: click the **?** button at the top right of any document to open it beside your page.

## 1. Choose the document style

Open a new document, click **Document style** (the **A** button at the top right of the editor, next to References), and under **Start from** choose:

| Style | What it sets |
| --- | --- |
| **Standard** | Docs' own look: one column, space between paragraphs, "Figure 1." captions. |
| **Article** | A LaTeX article: one column of 11pt Latin Modern, indented and justified paragraphs, "Figure 1:" captions, IEEE references. |
| **Journal, two columns** | A *Physical Review*-style paper: two columns of 10pt Latin Modern with 1.15 line spacing, a 10pt first-line indent, no space between paragraphs, justified and hyphenated text, "FIG. 1." and "TABLE I." captions, and APS references. |

Choose **Journal, two columns**. The page changes at once: narrower margins, two columns, and the LaTeX typeface. Text you type flows down the left column, then the right, then on to the next page.

You can fine-tune everything in the same panel:

- **Body text**: the **font**, **size**, **line spacing** (a multiple of the size: 1.15 gives 11.5pt lines for 10pt text), **first-line indent**, **space between paragraphs**, **justify** and **hyphenate**.
- **Columns**: one or two, and the **gutter** (space between columns) in inches.
- **Caption numbering**: how figures and tables are labelled (see [Captions](#6-figures-and-captions)).
- **Citation style**: how citations and the reference list are printed.

> **Tip:** Paragraphs follow LaTeX's rules automatically: a paragraph is indented unless it comes right after a heading. To start a paragraph flush left anyway (for example, text that continues after a display equation), choose **More → Blocks → No first-line indent**.

Paper size and margins are in **Page setup** (the sliders button). The Journal style sets 0.7in side margins on Letter paper; change them there if your journal asks for something else.

## 2. The title block, across both columns

In a two-column document, any block can **span both columns**: put the cursor in it and click **Span both columns** in the toolbar (the ↔ arrows button, which appears only in two-column documents; it's also under **More → Blocks**). Click it again to put the block back into one column.

Build the title block like this, spanning each part:

1. **Title.** Type it, choose **Heading 1**, centre it, and click **Span both columns**. Heading 1 is set bold; use the font size box to make it 12pt, the usual journal size.
2. **Authors.** A centred, spanned paragraph. For affiliation marks, select the "1" or "∗" after a name and press **Ctrl+.** (superscript).
3. **Affiliations and date.** Centred, spanned paragraphs; make the affiliation italic and 9pt to match most journals.
4. **Abstract.** A spanned paragraph at 9pt. To indent it on both sides the way RevTeX does, drag the left and right indent markers on the ruler in by about ¾ inch. It stays justified.

Everything after the abstract goes back to two columns automatically, because new paragraphs don't span unless you ask.

## 3. Sections and headings

Use **Heading 2** for sections ("I. INTRODUCTION"), **Heading 3** for subsections ("A. Notation") and **Heading 4** for sub-subsections. In a typeset document they follow the article classes: sections and subsections bold, sub-subsections italic, all at the body size. Centre a section heading if your journal does.

Type the section number as part of the heading; Docs doesn't number headings for you. Headings always stay with the text that follows them, so a heading never ends a column on its own.

The **Outline** button lists every heading. Click one to jump to it.

## 4. Equations

- **Inline:** type `$` followed by LaTeX and a closing `$`, for example `$g_A^e g_A^N$`. The formula is set in the same Computer Modern design as the text, at exactly the text size, and doesn't open up the line spacing.
- **Display:** on an empty line type `$$` and a space, then the LaTeX. Display equations are centred in their column and numbered (1), (2), … at the right margin.

Click an equation to edit it. Untick **Number this equation** for an unnumbered display.

**Wide equations.** A display equation too wide for its column is set slightly smaller to fit. If it would get too small to read, click **Span both columns** while it's selected to set it across the full page width, as journals do with long equations.

**Referring to an equation.** Use **Cross-reference** (the ↳ button), choose the **Equations** tab and pick the equation; it reads "Eq. (5)". For "Eqs. (4) and (5)", type "Eqs. " and insert two cross-references with **Number only** ticked, so they read just "(4)" and "(5)". Numbers update whenever equations are added, removed or moved.

## 5. Tables

Journal tables look different from spreadsheet grids: horizontal rules only, a rule under the header, columns sized to their content, and the table centred under its caption. Docs does this with **table styles**.

### Create the table

1. Put the cursor on an empty line and insert a table: the table button in the toolbar (drag to choose rows and columns), or type **/table**. The first row is a header row.
2. With the cursor in the table, open **Table options** (the table-and-gear button that appears in the toolbar while the cursor is in a table) and add the caption first: **Add caption**. Table captions go **above** the table, as journals print them, and read "TABLE I." in the Journal style.
3. Type the column names in the header row and the data below.

### Choose the table style

In **Table options → Table style**:

| Style | Looks like | Use for |
| --- | --- | --- |
| **Grid** | every cell outlined | working tables, forms, anything that isn't for publication |
| **Booktabs** | a rule above the table, one under the header row, one below the table | most journals (Elsevier, Springer, ACS, IEEE) and LaTeX's `booktabs` |
| **Journal** | double rules above and below, a single rule under the header | APS and RevTeX papers (*Physical Review*), as in the imported sample |
| **Contents** | no rules; dot leaders run from each entry's text to its page number | a list of figures or tables, or a hand-made contents page: make three columns (number, title, page) |

Then tick **Fit width to content**. The columns shrink to their contents and the table is centred, instead of stretching across the column. Untick it for a full-width table.

### Header rows

- **Toggle header row** makes the first row the header.
- For a **two-level header**, with a group label over several columns (for example "Matter" over two columns and "Antimatter" over two more), add a second row. Select the cells of the top row that belong together and choose **Merge cells**, then put the cursor in each cell of the second header row and choose **Toggle header cell**. The rule under the header is drawn under the last header row.
- Header cells aren't bold in Booktabs and Journal tables, as in print. Make them bold yourself if your journal wants it.

### Aligning columns

Put the cursor in a cell and use the toolbar's **align** buttons, cell by cell or over a selection of cells (drag across a column to select it). The usual convention is text left-aligned and numbers centred or right-aligned.

### Maths and formatting in cells

Cells hold normal text, so everything works inside them: inline equations (`$b_\mu$`, `$m^{-1}$`), bold symbols, superscripts, italic. Use **Shift+Enter** for a line break within a cell.

### Wide tables

A table with many columns can **span both columns**: with the cursor in it, choose **Span both columns** in **Table options** (or the toolbar button). Span the table's caption too, so they stay together.

### Notes under a table

For notes like "ᵃ Measured at 300 K.", add a small (8 or 9pt) paragraph straight after the table. Use superscript letters in the cells for the marks.

### Referring to a table

**Cross-reference → Tables** inserts "Table IV" (Journal style) or "Table 4". It updates if tables are added or reordered.

## 6. Figures and captions

1. Insert the image (toolbar image button, or paste it).
2. Click the image and choose **Caption** in its toolbar. A figure caption goes **under** the figure and reads "FIG. 1." in the Journal style.
3. Resize the image with its handles. In a two-column page it can't be wider than the column; for a full-width figure, click the paragraph holding the image and choose **Span both columns**, then span the caption too.

**Caption numbering** in **Document style** chooses the labels:

| Choice | Figures | Tables | Label |
| --- | --- | --- | --- |
| **Docs / Word** | Figure 1. | Table 1. | bold |
| **APS / RevTeX** | FIG. 1. | TABLE I. | plain |
| **IEEE** | Fig. 1. | TABLE I | plain |
| **LaTeX article** | Figure 1: | Table 1: | plain |

Captions renumber themselves when figures or tables are added, removed or moved, and so does every cross-reference to them.

**Theses and books** number figures, tables and equations within chapters: "Figure 4.6", "Table 2.1", "(2.3)". Set **Document style → Number within chapters** to the heading level your chapters use. A chapter heading can carry its own number ("Chapter 2", "CHAPTER FOUR", "Appendix A"), and headings without one (References, Acknowledgements) don't start a chapter. If no chapter heading has a number, chapters are simply counted.

## 7. Citations and the reference list

1. Open **References** (the books icon) and add your references: paste DOIs or arXiv IDs, BibTeX entries, or import a .bib file.
2. Cite in the text with the quote button (or **/citation**). In the Journal style, citations read [1], [2, 3], [4–7], numbered in the order you first cite them.
3. At the end of the paper, insert the reference list with **/reference list**. In a two-column paper it runs down the columns like the rest of the text. If you don't want its "References" heading, delete it: APS papers have none.

Change **Citation style** in Document style or the References panel, and every citation and the reference list are reformatted at once.

## 8. Acknowledgments and appendices

An acknowledgments section is a **Heading 2** ("ACKNOWLEDGMENTS") followed by normal paragraphs. Appendices are sections like any other ("Appendix A: Derivation"). To start the appendices or the references on a new page, insert a **Page break** (**Ctrl+Enter**).

## 9. Checking and exporting

- The header shows the page count; scroll through the pages to check where columns break. A figure, table or equation is never split between columns, and headings stay with their text.
- **Export → PDF document** prints the paper with the same columns, fonts and spacing. **Print…** does the same.
- **Export → Word document** gives an editable .docx, with equations as Word equations and cross-references as links. Columns and table styles aren't exported to Word yet; the .docx comes out in one column with full table grids.

## Quick reference

| To… | Do this |
| --- | --- |
| Make the whole document a two-column paper | **Document style → Journal, two columns** |
| Change body font, size, spacing or indent | **Document style → Body text** |
| Stretch a block across both columns | cursor in it → **Span both columns** (↔ button) |
| Journal-style table rules | cursor in table → **Table options → Table style → Journal** or **Booktabs** |
| Narrow, centred table | **Table options → Fit width to content** |
| Two-level table header | **Merge cells** in the top row, **Toggle header cell** in the second |
| "FIG. 1." / "TABLE I." captions | **Document style → Caption numbering → APS / RevTeX** |
| "Figs. 2 and 3" | two cross-references with **Number only** ticked |
| A paragraph without its first-line indent | **More → Blocks → No first-line indent** |
