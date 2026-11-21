import sanitizeHtml from 'sanitize-html';

/** Video embeds allowed inside blog content. */
const ALLOWED_IFRAME_HOSTS = [
  'www.youtube.com',
  'youtube.com',
  'www.youtube-nocookie.com',
  'player.vimeo.com',
];

/**
 * Rich-text content is rendered as HTML on the public site, so it is cleaned
 * on write: scripts, event handlers, `javascript:` URLs and unknown embeds are
 * removed while normal editor formatting (headings, lists, tables, images,
 * code, inline styles and classes) is kept.
 */
export function sanitizeBlogContent(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: [
      ...sanitizeHtml.defaults.allowedTags,
      'img',
      'figure',
      'figcaption',
      'iframe',
      'video',
      'source',
      'span',
      'u',
      's',
      'del',
      'ins',
      'mark',
      'sub',
      'sup',
      'h1',
      'h2',
    ],
    allowedAttributes: {
      '*': ['class', 'style', 'id', 'title', 'dir', 'lang'],
      a: ['href', 'name', 'target', 'rel'],
      img: ['src', 'srcset', 'sizes', 'alt', 'width', 'height', 'loading', 'decoding'],
      iframe: ['src', 'width', 'height', 'allow', 'allowfullscreen', 'frameborder', 'loading'],
      video: [
        'src',
        'poster',
        'controls',
        'width',
        'height',
        'preload',
        'muted',
        'loop',
        'playsinline',
      ],
      source: ['src', 'type'],
      td: ['colspan', 'rowspan'],
      th: ['colspan', 'rowspan', 'scope'],
      ol: ['start', 'type'],
    },
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowedSchemesByTag: { img: ['http', 'https', 'data'] },
    allowedIframeHostnames: ALLOWED_IFRAME_HOSTS,
    allowProtocolRelative: false,
    // Drop embeds whose source was removed (e.g. an iframe from a non-allowed host).
    exclusiveFilter: (frame) =>
      ['iframe', 'video', 'source'].includes(frame.tag) && !frame.attribs.src,
    transformTags: {
      // Links opening a new tab must not expose window.opener.
      a: (tagName, attribs) => ({
        tagName,
        attribs: attribs.target === '_blank' ? { ...attribs, rel: 'noopener noreferrer' } : attribs,
      }),
    },
  });
}
