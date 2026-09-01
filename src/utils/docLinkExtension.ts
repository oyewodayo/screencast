// utils/docLinkExtension.ts
//
// Extends @tiptap/extension-link with one attribute, `underlineOff`, so a link's underline can be
// removed while it stays a link (blue, clickable) - the toolbar's existing Underline button toggles
// this attribute instead of the generic `underline` mark whenever the selection is on a link (see
// DocsEditor.tsx). A plain `underline` mark can't do this job on its own: an autolinked URL/email
// never gets that mark applied automatically, only the CSS default in docLinks.css does, and CSS
// alone can't be "toggled off" per-instance the way a mark or attribute can. Putting the flag
// directly on the link mark (rather than trying to synchronize a separate underline mark onto every
// link, from every creation path - manual, autolink-on-type, autolink-on-paste, docx import) means
// there's nothing to keep in sync: the attribute travels with the mark itself.
import Link from "@tiptap/extension-link";

const DocLink = Link.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      underlineOff: {
        default: false,
        parseHTML: (element) => element.hasAttribute("data-underline-off"),
        renderHTML: (attributes) => (attributes.underlineOff ? { "data-underline-off": "" } : {}),
      },
    };
  },
});

export default DocLink;
