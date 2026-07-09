// AdminView.js
import React, { useState, useEffect, useRef } from 'react';
import { auth, db } from './firebase';
import { signOut } from 'firebase/auth';
import {
  collection,
  getDocs,
  doc,
  updateDoc,
  deleteDoc,
  addDoc,
  serverTimestamp,
  writeBatch
} from 'firebase/firestore';
import './AdminView.css';

// ─────────────────────────────────────────────────────────────
// NAV MENU ORDER
// ─────────────────────────────────────────────────────────────
const NAV_MENU = [
  { label: 'Home',               slugs: ['home', '/psm/$', '/psm/home'] },
  { label: 'About PSM',          slugs: ['about', 'about-psm'] },
  { label: 'Committee Member',   slugs: ['committee', 'committee-member'] },
  { label: 'PSM Calendar',       slugs: ['calendar', 'psm-calendar'] },
  { label: 'PSM Materials',      slugs: ['material', 'psm-material'] },
  { label: 'PSM Form',           slugs: ['form', 'psm-form'] },
  { label: 'PSM Title Samples',  slugs: ['title', 'title-sample'] },
  { label: 'PSM System Online',  slugs: ['system', 'psm-system', 'online'] },
  { label: 'Statistic',          slugs: ['statistic'] },
  { label: 'PSM Presentation',   slugs: ['presentation', 'psm-presentation'] },
  { label: 'Lab',                slugs: ['lab'] },
  { label: 'Proceeding',         slugs: ['proceeding'] },
  { label: 'IDEAS',              slugs: ['ideas', 'idea'] },
  { label: 'Projects Offered',   slugs: ['project', 'projects-offered'] },
  { label: 'QIU FYP ONLY',       slugs: ['qiu', 'fyp'] },
  { label: 'PSMi',               slugs: ['psmi'] },
];

function getNavIndex(section) {
  const haystack = [
    (section.path        || '').toLowerCase(),
    (section.page_url    || '').toLowerCase(),
    (section.page_title  || '').toLowerCase(),
    (section.heading     || '').toLowerCase(),
  ].join(' ');

  if (/^\/psm\/?$/.test((section.path || '').trim()) ||
      /^\/psm\/?$/.test((section.page_url || '').trim().replace(/^https?:\/\/[^/]+/, ''))) {
    return 0;
  }

  for (let i = 0; i < NAV_MENU.length; i++) {
    for (const slug of NAV_MENU[i].slugs) {
      if (haystack.includes(slug)) return i;
    }
  }
  return NAV_MENU.length;
}

// ─────────────────────────────────────────────────────────────
// RICH TEXT HELPERS
// ─────────────────────────────────────────────────────────────
// Detects whether a content string is already HTML (new rich-text format)
// vs legacy plain text (scraped/entered before rich text existed).
function isHtmlContent(str) {
  if (!str) return false;
  return /<\/?[a-z][\s\S]*>/i.test(str);
}

// Converts legacy plain text (with \n\n paragraph breaks) into basic HTML
// paragraphs, so it can be loaded into the rich text editor without losing
// its original line breaks.
function plainTextToHtml(text) {
  if (!text) return '';
  return text
    .split(/\n{2,}/)
    .map(para => `<p>${para.replace(/\n/g, '<br>')}</p>`)
    .join('');
}

// Strips tags to get plain text — used for "is this field actually empty?"
// checks, since an HTML string like "<p><br></p>" isn't empty as a string
// but has no visible content.
function stripHtml(html) {
  if (!html) return '';
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  return (tmp.textContent || tmp.innerText || '').trim();
}

// Repairs the "list nested inside a list item" markup that browsers can
// produce via execCommand (the bug where item 2 and 3 render indented
// under item 1 instead of lining up with it). Walks the HTML, and for
// every <ul>/<ol> found nested inside an <li>, splits the parent list at
// that point and re-inserts the nested list as a sibling — continuing
// the outer list's numbering correctly afterward.
function normalizeNestedLists(html) {
  if (!html) return html;
  const container = document.createElement('div');
  container.innerHTML = html;

  let safety = 0;
  while (safety < 500) {
    const nested = container.querySelector('li > ul, li > ol');
    if (!nested) break;
    safety++;

    const li = nested.parentElement;
    const parentList = li.parentElement; // the ul/ol that holds `li`
    const grandParent = parentList ? parentList.parentElement : null;
    if (!parentList || !grandParent) break;

    li.removeChild(nested); // detach nested list from the item

    const siblings   = Array.from(parentList.children);
    const idx        = siblings.indexOf(li);
    const afterItems = siblings.slice(idx + 1);
    const refNode    = parentList.nextSibling;

    if (afterItems.length === 0) {
      // Nothing follows this item — just place the nested list right after.
      grandParent.insertBefore(nested, refNode);
    } else {
      // Items follow — split them into a new list that continues numbering.
      const tag = parentList.tagName; // 'UL' or 'OL'
      const afterList = document.createElement(tag);
      if (tag === 'OL') {
        const originalStart = parseInt(parentList.getAttribute('start') || '1', 10);
        afterList.setAttribute('start', String(originalStart + idx + 1));
      }
      afterItems.forEach(item => afterList.appendChild(item));

      grandParent.insertBefore(nested, refNode);
      grandParent.insertBefore(afterList, refNode);
    }
  }

  return container.innerHTML;
}

function groupSectionsByNav(sections, direction = 'asc') {
  const buckets = {};
  for (const s of sections) {
    const idx = getNavIndex(s);
    if (!buckets[idx]) {
      buckets[idx] = {
        navIndex: idx,
        label: idx < NAV_MENU.length ? NAV_MENU[idx].label : 'Other',
        sections: [],
      };
    }
    buckets[idx].sections.push(s);
  }
  return Object.values(buckets).sort((a, b) =>
    direction === 'asc' ? a.navIndex - b.navIndex : b.navIndex - a.navIndex
  );
}

// ─────────────────────────────────────────────────────────────
// NAV GROUP
// ─────────────────────────────────────────────────────────────
function NavGroup({ label, navIndex, sections, onSave, onDelete, onToggleApproval }) {
  const [open, setOpen] = useState(true);

  const approvedCount = sections.filter(s => s.approved).length;
  const pendingCount  = sections.length - approvedCount;
  const isHome = navIndex === 0;
  const accent = isHome ? '#2ec4b6' : navIndex < NAV_MENU.length ? '#7c3aed' : '#ff9f1c';

  return (
    <div style={{ marginBottom: 18 }}>
      <div
        onClick={() => setOpen(v => !v)}
        style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '10px 16px', background: 'var(--bg-surface)',
          border: '1px solid var(--border)', borderLeft: `4px solid ${accent}`,
          borderRadius: open ? '8px 8px 0 0' : 8, cursor: 'pointer',
          userSelect: 'none', transition: 'background 0.15s',
        }}
      >
        <span style={{
          fontSize: 11, color: 'var(--text-muted)',
          transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
          transition: 'transform 0.2s', display: 'inline-block', width: 12, flexShrink: 0,
        }}>▶</span>
        <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', flex: 1 }}>
          {label}
        </span>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          {sections.length} section{sections.length !== 1 ? 's' : ''}
        </span>
        {approvedCount > 0 && (
          <span style={{ fontSize: 10, fontWeight: 600, background: 'rgba(46,196,182,0.15)', color: '#2ec4b6', borderRadius: 4, padding: '2px 7px' }}>
            ✅ {approvedCount}
          </span>
        )}
        {pendingCount > 0 && (
          <span style={{ fontSize: 10, fontWeight: 600, background: 'rgba(255,159,28,0.15)', color: '#ff9f1c', borderRadius: 4, padding: '2px 7px' }}>
            ⏳ {pendingCount}
          </span>
        )}
      </div>
      {open && (
        <div style={{ border: '1px solid var(--border)', borderTop: 'none', borderRadius: '0 0 8px 8px', overflow: 'hidden' }}>
          {sections.map(section => (
            <KbRow key={section.id} section={section} onSave={onSave} onDelete={onDelete} onToggleApproval={onToggleApproval} />
          ))}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// IMAGE CONTEXT PANEL
// ─────────────────────────────────────────────────────────────
function ImageContextPanel({ imageContext, sectionId, onUpdateImageContext }) {
  const [expandedIndex, setExpandedIndex] = useState(null);
  const [editingIndex,  setEditingIndex]  = useState(null);
  const [draftDesc,     setDraftDesc]     = useState('');

  let items = [];
  if (Array.isArray(imageContext)) {
    items = imageContext.filter(item => item && (item.url || item.description));
  } else if (typeof imageContext === 'string' && imageContext.trim()) {
    items = [{ url: null, description: imageContext }];
  }

  const startEditDesc = (e, idx, currentDesc) => {
    e.stopPropagation();
    setEditingIndex(idx);
    setDraftDesc(currentDesc || '');
  };

  const cancelEditDesc = (e) => {
    e.stopPropagation();
    setEditingIndex(null);
  };

  const saveEditDesc = async (e, idx) => {
    e.stopPropagation();
    const updated = items.map((item, i) =>
      i === idx ? { ...item, description: draftDesc, manually_corrected: true } : item
    );
    await onUpdateImageContext(sectionId, updated);
    setEditingIndex(null);
  };

  if (items.length === 0) return null;

  return (
    <div className="kb-field" style={{ marginTop: 4 }}>
      <span className="kb-field-label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        🔭 AI Vision Context
        <span style={{ fontSize: 10, fontWeight: 500, background: 'linear-gradient(90deg, #7c3aed, #2563eb)', color: '#fff', borderRadius: 4, padding: '1px 7px', letterSpacing: '0.04em', textTransform: 'uppercase' }}>
          LLaVA
        </span>
        <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>
          {items.length} image{items.length !== 1 ? 's' : ''} analysed
        </span>
      </span>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 6 }}>
        {items.map((item, idx) => {
          const isExpanded = expandedIndex === idx;
          const isEditing  = editingIndex  === idx;
          const filename   = item.url ? item.url.split('/').pop().split('?')[0] : `Image ${idx + 1}`;
          const shortDesc  = item.description ? item.description.slice(0, 120) + (item.description.length > 120 ? '…' : '') : '';

          return (
            <div
              key={idx}
              style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden', background: 'var(--bg-input, rgba(255,255,255,0.03))', transition: 'border-color 0.15s' }}
              onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--border-hover)'}
              onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--border)'}
            >
              <div
                style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', cursor: 'pointer', userSelect: 'none' }}
                onClick={() => setExpandedIndex(isExpanded ? null : idx)}
              >
                {item.url ? (
                  <img src={item.url} alt={filename} onError={e => { e.target.style.display = 'none'; }}
                    style={{ width: 52, height: 40, objectFit: 'cover', borderRadius: 5, border: '1px solid var(--border)', flexShrink: 0, background: 'var(--bg-surface)' }} />
                ) : (
                  <div style={{ width: 52, height: 40, borderRadius: 5, background: 'var(--bg-surface)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, flexShrink: 0 }}>🖼️</div>
                )}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{filename}</span>
                    {item.manually_corrected && (
                      <span style={{ fontSize: 9, background: 'var(--border-hover)', color: 'var(--text-secondary)', padding: '1px 4px', borderRadius: 3 }}>Edited</span>
                    )}
                  </div>
                  {!isExpanded && shortDesc && (
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2, lineHeight: 1.4 }}>{shortDesc}</div>
                  )}
                </div>
                {item.processed_at && (
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', whiteSpace: 'nowrap', flexShrink: 0 }}>
                    {new Date(item.processed_at).toLocaleString()}
                  </div>
                )}
                <span style={{ fontSize: 11, color: 'var(--text-muted)', transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.2s', flexShrink: 0 }}>▶</span>
              </div>

              {isExpanded && (
                <div style={{ borderTop: '1px solid var(--border)', padding: '12px 14px', display: 'flex', gap: 14, flexWrap: 'wrap' }}>
                  {item.url && (
                    <div style={{ flexShrink: 0 }}>
                      <img src={item.url} alt={filename} onError={e => { e.target.style.display = 'none'; }}
                        style={{ maxWidth: 280, maxHeight: 200, objectFit: 'contain', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-surface)', display: 'block' }} />
                      <a href={item.url} target="_blank" rel="noreferrer"
                        style={{ display: 'block', fontSize: 10, color: 'var(--text-muted)', marginTop: 5, textDecoration: 'underline' }}
                        onClick={e => e.stopPropagation()}>Open original ↗</a>
                    </div>
                  )}
                  <div style={{ flex: 1, minWidth: 180 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'between', marginBottom: 6 }}>
                      <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', flex: 1 }}>
                        LLaVA Description Summary
                      </span>
                      {!isEditing ? (
                        <button onClick={(e) => startEditDesc(e, idx, item.description)}
                          style={{ background: 'transparent', border: 'none', color: '#7c3aed', cursor: 'pointer', fontSize: 11, fontWeight: 500 }}>
                          ✏️ Edit Prompt Content
                        </button>
                      ) : (
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button onClick={(e) => saveEditDesc(e, idx)}
                            style={{ background: '#2ec4b6', border: 'none', color: '#fff', padding: '2px 6px', borderRadius: 4, cursor: 'pointer', fontSize: 11 }}>Save</button>
                          <button onClick={cancelEditDesc}
                            style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 11 }}>Cancel</button>
                        </div>
                      )}
                    </div>
                    {isEditing ? (
                      <textarea className="form-textarea" value={draftDesc} onChange={e => setDraftDesc(e.target.value)} rows={5}
                        style={{ width: '100%', fontSize: 12, lineHeight: 1.6, background: 'var(--bg-surface)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 6, padding: 8 }} />
                    ) : (
                      <p style={{ fontSize: 12, color: 'var(--text-primary)', lineHeight: 1.75, margin: 0, whiteSpace: 'pre-wrap', borderLeft: '2px solid #7c3aed', paddingLeft: 10 }}>
                        {item.description || <em style={{ color: 'var(--text-muted)' }}>No description available.</em>}
                      </p>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// RICH TEXT EDITOR
// ─────────────────────────────────────────────────────────────
// Small, dependency-free WYSIWYG editor built on contentEditable +
// document.execCommand. Supports Bold, Italic, Underline, Headings,
// and numbered/bulleted lists — enough for formatting KB content
// without pulling in an external editor library.
function RichTextEditor({ value, onChange, minHeight = 380, placeholder = 'Start typing content…' }) {
  const editorRef = useRef(null);

  // Only push `value` into the DOM when it differs from what's already
  // there — this keeps the caret from jumping around while typing, since
  // onInput already updates the parent with the current DOM content.
  useEffect(() => {
    if (editorRef.current && editorRef.current.innerHTML !== (value || '')) {
      editorRef.current.innerHTML = value || '';
    }
  }, [value]);

  const exec = (command, arg = null) => {
    editorRef.current?.focus();

    // Toggling list type (numbered ↔ bulleted) while the caret is still
    // inside an existing list item is what makes browsers nest the new
    // list inside the old <li> instead of replacing it — that's the
    // "item 2 and 3 indented under item 1" bug. Resetting the current
    // block to a plain paragraph first removes that list context, so
    // the new list starts flat instead of nesting.
    if (command === 'insertOrderedList' || command === 'insertUnorderedList') {
      document.execCommand('formatBlock', false, 'P');
    }

    document.execCommand(command, false, arg);
    onChange(editorRef.current.innerHTML);
  };

  const handleInput = () => onChange(editorRef.current.innerHTML);

  const ToolbarBtn = ({ onClick, title, children }) => (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault()} // keeps text selection/focus inside the editor
      onClick={onClick}
      title={title}
      style={{
        border: '1px solid var(--border)',
        background: 'var(--bg-surface)',
        color: 'var(--text-primary)',
        borderRadius: 5,
        padding: '5px 9px',
        fontSize: 12,
        fontWeight: 700,
        cursor: 'pointer',
        lineHeight: 1,
      }}
    >
      {children}
    </button>
  );

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
      <style>{`
        .rich-text-editor, .kb-rich-content {
          width: 100%;
          box-sizing: border-box;
          overflow-wrap: break-word;
          word-wrap: break-word;
          word-break: break-word;
        }
        .rich-text-editor h1, .kb-rich-content h1 { font-size: 20px; font-weight: 700; margin: 14px 0 8px; }
        .rich-text-editor h2, .kb-rich-content h2 { font-size: 17px; font-weight: 700; margin: 12px 0 6px; }
        .rich-text-editor h3, .kb-rich-content h3 { font-size: 15px; font-weight: 600; margin: 10px 0 5px; }
        .rich-text-editor h4, .kb-rich-content h4 { font-size: 13px; font-weight: 600; margin: 8px 0 4px; text-transform: uppercase; letter-spacing: 0.03em; color: var(--text-secondary, var(--text-primary)); }
        .rich-text-editor p,  .kb-rich-content p  { margin: 0 0 10px; overflow-wrap: break-word; }
        .rich-text-editor ul, .kb-rich-content ul { margin: 6px 0 10px 22px; padding: 0; max-width: 100%; }
        .rich-text-editor ol, .kb-rich-content ol { margin: 6px 0 10px 22px; padding: 0; max-width: 100%; }
        .rich-text-editor li, .kb-rich-content li { margin-bottom: 4px; overflow-wrap: break-word; }
        .rich-text-editor:empty:before { content: attr(data-placeholder); color: var(--text-muted); pointer-events: none; }
      `}</style>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', padding: '8px 10px', background: 'var(--bg-surface)', borderBottom: '1px solid var(--border)' }}>
        <select
          onMouseDown={(e) => e.stopPropagation()}
          onChange={(e) => { exec('formatBlock', e.target.value); e.target.value = ''; }}
          defaultValue=""
          title="Text style"
          style={{
            border: '1px solid var(--border)',
            background: 'var(--bg-surface)',
            color: 'var(--text-primary)',
            borderRadius: 5,
            padding: '5px 8px',
            fontSize: 12,
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          <option value="" disabled>Text style…</option>
          <option value="P">Normal text</option>
          <option value="H2">Heading 1</option>
          <option value="H3">Heading 2</option>
          <option value="H4">Heading 3</option>
        </select>
        <span style={{ width: 1, background: 'var(--border)', margin: '2px 2px' }} />
        <ToolbarBtn onClick={() => exec('bold')} title="Bold"><b>B</b></ToolbarBtn>
        <ToolbarBtn onClick={() => exec('italic')} title="Italic"><i>I</i></ToolbarBtn>
        <ToolbarBtn onClick={() => exec('underline')} title="Underline"><u>U</u></ToolbarBtn>
        <span style={{ width: 1, background: 'var(--border)', margin: '2px 2px' }} />
        <ToolbarBtn onClick={() => exec('insertUnorderedList')} title="Bullet list">• List</ToolbarBtn>
        <ToolbarBtn onClick={() => exec('insertOrderedList')} title="Numbered list">1. List</ToolbarBtn>
        <span style={{ width: 1, background: 'var(--border)', margin: '2px 2px' }} />
        <ToolbarBtn onClick={() => exec('removeFormat')} title="Clear formatting">Clear</ToolbarBtn>
      </div>
      <div
        ref={editorRef}
        className="rich-text-editor"
        contentEditable
        suppressContentEditableWarning
        data-placeholder={placeholder}
        onInput={handleInput}
        style={{
          minHeight,
          maxHeight: 600,
          overflowY: 'auto',
          padding: 12,
          fontSize: 14,
          lineHeight: 1.7,
          color: 'var(--text-primary)',
          background: 'transparent',
          outline: 'none',
        }}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// KB ROW
// ─────────────────────────────────────────────────────────────
function KbRow({ section, onSave, onDelete, onToggleApproval }) {
  const [expanded, setExpanded] = useState(false);
  const [editing,  setEditing]  = useState(false);
  const [draft,    setDraft]    = useState({});

  const startEdit = (e) => {
    e.stopPropagation();
    const rawContent = section.content ?? '';
    setDraft({
      page_title:    section.page_title    ?? '',
      page_url:      section.page_url      ?? '',
      path:          section.path          ?? '',
      heading:       section.heading       ?? '',
      // Legacy sections store plain text; convert to HTML. Sections with
      // HTML already get their nested-list markup repaired here too, so
      // re-saving after edit permanently fixes the underlying data.
      content:       isHtmlContent(rawContent) ? normalizeNestedLists(rawContent) : plainTextToHtml(rawContent),
      picture_links: (section.picture_links ?? []).join('\n'),
      doc_links:     (section.doc_links     ?? []).join('\n'),
    });
    setEditing(true);
    setExpanded(true);
  };

  const cancelEdit = (e) => { e?.stopPropagation(); setEditing(false); };

  const handleSave = async (e) => {
    e.stopPropagation();
    const payload = {
      page_title:    draft.page_title.trim(),
      page_url:      draft.page_url.trim(),
      path:          draft.path.trim(),
      heading:       draft.heading.trim(),
      content:       normalizeNestedLists(draft.content.trim()),
      picture_links: draft.picture_links.split('\n').map(s => s.trim()).filter(Boolean),
      doc_links:     draft.doc_links.split('\n').map(s => s.trim()).filter(Boolean),
    };
    await onSave(section.id, payload);
    setEditing(false);
  };

  const handleUpdateImageContext = async (id, updatedContextArray) => {
    await onSave(id, { image_context: updatedContextArray });
  };

  const handleDelete   = (e) => { e.stopPropagation(); onDelete(section.id); };
  const handleApproval = (e) => { e.stopPropagation(); onToggleApproval(section); };

  const field = (key, label, rows = 1, hint = '', textareaStyle = {}) => (
    <div className="kb-field">
      <span className="kb-field-label">{label}{hint && <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}> — {hint}</span>}</span>
      {rows > 1
        ? <textarea className="form-textarea" rows={rows} value={draft[key] ?? ''} onChange={e => setDraft(p => ({ ...p, [key]: e.target.value }))}
            style={{ width: '100%', resize: 'vertical', ...textareaStyle }} />
        : <input    className="form-input"                value={draft[key] ?? ''} onChange={e => setDraft(p => ({ ...p, [key]: e.target.value }))} />
      }
    </div>
  );

  const imageContextCount = Array.isArray(section.image_context)
    ? section.image_context.filter(i => i?.description).length
    : 0;

  return (
    <div className={`kb-row${expanded ? ' expanded' : ''}`}>
      <div className="kb-row-header" onClick={() => setExpanded(v => !v)}>
        <span className="kb-chevron">▶</span>
        <span className="kb-col-title"   title={section.page_title}>{section.page_title || '—'}</span>
        <span className="kb-col-heading" title={section.heading}>{section.heading || <em style={{ color: 'var(--text-muted)' }}>No heading</em>}</span>
        <span className="kb-col-path"    title={section.path}>{section.path || '—'}</span>
        <span className="kb-col-status"  style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span className={`badge ${section.approved ? 'badge-approved' : 'badge-pending'}`}>
            {section.approved ? '✅ Approved' : '⏳ Pending'}
          </span>
          {imageContextCount > 0 && (
            <span style={{ fontSize: 10, background: 'linear-gradient(90deg, #7c3aed, #2563eb)', color: '#fff', borderRadius: 4, padding: '1px 6px', fontWeight: 600, letterSpacing: '0.03em', whiteSpace: 'nowrap' }}>
              🔭 {imageContextCount} vision
            </span>
          )}
        </span>
        <span />
      </div>

      {expanded && (
        <div className="kb-row-body">
          {editing ? (
            <>
              <div className="kb-field-2col">
                {field('page_title', 'Page Title')}
                {field('heading',    'Section Heading')}
              </div>
              <div className="kb-field-2col">
                {field('page_url', 'Page URL')}
                {field('path',     'Path')}
              </div>
              <div className="kb-field">
                <span className="kb-field-label">Content</span>
                <RichTextEditor
                  value={draft.content ?? ''}
                  onChange={(html) => setDraft(p => ({ ...p, content: html }))}
                  minHeight={380}
                />
              </div>
              {field('picture_links', 'Picture Links',  3, 'one URL per line')}
              {field('doc_links',     'Document Links', 3, 'one URL per line')}
              {imageContextCount > 0 && (
                <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '4px 0 0' }}>
                  ℹ️ AI Vision Descriptions can be modified inside Read-Mode via individual panel prompt editors.
                </p>
              )}
            </>
          ) : (
            <>
              <div className="kb-field-2col">
                <div className="kb-field">
                  <span className="kb-field-label">Page URL</span>
                  {section.page_url
                    ? <a href={section.page_url} target="_blank" rel="noreferrer" className="kb-link-badge" style={{ maxWidth: '100%' }}>{section.page_url}</a>
                    : <span className="kb-links-empty">—</span>}
                </div>
                <div className="kb-field">
                  <span className="kb-field-label">Path</span>
                  <code style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{section.path || '—'}</code>
                </div>
              </div>
              <div className="kb-field">
                <span className="kb-field-label">Content</span>
                <div style={{ fontSize: 13, color: 'var(--text-primary)', lineHeight: 1.7, borderLeft: '2px solid var(--border-hover)', paddingLeft: 10, width: '100%', maxWidth: '100%', boxSizing: 'border-box', overflowWrap: 'break-word' }}>
                  {!section.content ? (
                    <em style={{ color: 'var(--text-muted)' }}>No content.</em>
                  ) : isHtmlContent(section.content) ? (
                    <div className="kb-rich-content" dangerouslySetInnerHTML={{ __html: normalizeNestedLists(section.content) }} />
                  ) : (
                    <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{section.content}</p>
                  )}
                </div>
              </div>
              <ImageContextPanel imageContext={section.image_context} sectionId={section.id} onUpdateImageContext={handleUpdateImageContext} />
              <div className="kb-field">
                <span className="kb-field-label">Picture Links</span>
                {(section.picture_links ?? []).length > 0 ? (
                  <div className="kb-links">
                    {section.picture_links.map((l, i) => (
                      <a key={i} href={l} target="_blank" rel="noreferrer" className="kb-link-badge" title={l}>🖼️ {l.split('/').pop() || l}</a>
                    ))}
                  </div>
                ) : <span className="kb-links-empty">None</span>}
              </div>
              <div className="kb-field">
                <span className="kb-field-label">Document Links</span>
                {(section.doc_links ?? []).length > 0 ? (
                  <div className="kb-links">
                    {section.doc_links.map((l, i) => (
                      <a key={i} href={l} target="_blank" rel="noreferrer" className="kb-link-badge" title={l}>📁 {l.split('/').pop() || l}</a>
                    ))}
                  </div>
                ) : <span className="kb-links-empty">None</span>}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                Scraped: {section.scraped_at ? new Date(section.scraped_at).toLocaleString() : '—'}
              </div>
            </>
          )}
          <div className="kb-row-actions">
            {editing ? (
              <>
                <button className="kb-btn" onClick={cancelEdit}>Cancel</button>
                <button className="kb-btn save" onClick={handleSave}>💾 Save</button>
              </>
            ) : (
              <>
                <button className={`kb-btn ${section.approved ? 'revoke' : 'approve'}`} onClick={handleApproval}>
                  {section.approved ? '⏳ Revoke' : '✅ Approve'}
                </button>
                <button className="kb-btn" onClick={startEdit}>✏️ Edit</button>
                <button className="kb-btn delete" onClick={handleDelete}>🗑️ Delete</button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// MAIN ADMIN VIEW
// ─────────────────────────────────────────────────────────────
export default function AdminView({ user, theme, toggleTheme }) {
  const [activeTab, setActiveTab] = useState('users');

  // ── Users tab ──
  const [users,        setUsers]        = useState([]);
  const [usersLoading, setUsersLoading] = useState(false);

  // ── Knowledge Base tab ──
  const [sections,         setSections]         = useState([]);
  const [sectionsLoading,  setSectionsLoading]  = useState(false);
  const [showAddForm,      setShowAddForm]      = useState(false);
  const [isBulkApproving,  setIsBulkApproving]  = useState(false);
  const [isBulkDeleting,   setIsBulkDeleting]   = useState(false);
  const [newSection,       setNewSection]       = useState({
    page_title: '', page_url: '', path: '', heading: '', content: '',
    picture_links: '', doc_links: '',
  });
  const [searchTerm, setSearchTerm] = useState('');
  const [viewMode,   setViewMode]   = useState('nav');

  // ── AI Generate tab ──
  const [genRunning,   setGenRunning]   = useState(false);
  const [genLog,       setGenLog]       = useState([]);
  const [genProgress,  setGenProgress]  = useState(0);
  const [activeTask,   setActiveTask]   = useState(null); // 'rebuild' | 'scrape' | null
  const logEndRef = useRef(null);                         // auto-scroll anchor
  const abortControllerRef = useRef(null);                // lets us cancel the running task client-side

  // ── Status flash ──
  const [statusMsg, setStatusMsg] = useState('');
  const flash = (msg) => { setStatusMsg(msg); setTimeout(() => setStatusMsg(''), 3500); };

  // ── Derived KB stats ──
  const totalApproved  = sections.filter(s => s.approved).length;
  const totalPending   = sections.length - totalApproved;
  const uniquePages    = new Set(sections.map(s => s.page_url)).size;
  const totalWithVision = sections.filter(s =>
    Array.isArray(s.image_context) && s.image_context.some(i => i?.description)
  ).length;

  const filteredSections = sections
    .filter(s => {
      const term = searchTerm.toLowerCase();
      return (
        (s.page_title && s.page_title.toLowerCase().includes(term)) ||
        (s.heading    && s.heading.toLowerCase().includes(term))    ||
        (s.path       && s.path.toLowerCase().includes(term))       ||
        (s.content    && s.content.toLowerCase().includes(term))
      );
    })
    .sort((a, b) => {
      const navA = getNavIndex(a), navB = getNavIndex(b);
      if (navA !== navB) return navA - navB;
      const pathA = (a.path || '').toLowerCase(), pathB = (b.path || '').toLowerCase();
      if (pathA !== pathB) return pathA.localeCompare(pathB);
      return (a.scraped_at || a.id || '').localeCompare(b.scraped_at || b.id || '');
    });

  const pendingFilteredSections = filteredSections.filter(s => !s.approved);
  const navGroups = groupSectionsByNav(filteredSections);

  // ── Auto-scroll log terminal ──
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [genLog]);

  // ── Data fetching ──
  useEffect(() => {
    if (activeTab !== 'users') return;
    setUsersLoading(true);
    getDocs(collection(db, 'users'))
      .then(snap => setUsers(snap.docs.map(d => ({ id: d.id, ...d.data() }))))
      .catch(err => flash(`❌ ${err.message}`))
      .finally(() => setUsersLoading(false));
  }, [activeTab]);

  useEffect(() => {
    if (activeTab !== 'kb') return;
    setSectionsLoading(true);
    getDocs(collection(db, 'psm_sections'))
      .then(snap => setSections(snap.docs.map(d => ({ id: d.id, ...d.data() }))))
      .catch(err => flash(`❌ Permission denied: ${err.message}`))
      .finally(() => setSectionsLoading(false));
  }, [activeTab]);

  // ── User actions ──
  const toggleRole = async (u) => {
    const newRole = u.role === 'admin' ? 'user' : 'admin';
    try {
      await updateDoc(doc(db, 'users', u.id), { role: newRole });
      setUsers(prev => prev.map(x => x.id === u.id ? { ...x, role: newRole } : x));
      flash(`Updated ${u.utm_gmail || u.email} → ${newRole}`);
    } catch (err) { flash(`❌ Update failed: ${err.message}`); }
  };

  // ── KB actions ──
  const saveSection = async (id, payload) => {
    try {
      await updateDoc(doc(db, 'psm_sections', id), { ...payload, updatedAt: serverTimestamp() });
      setSections(prev => prev.map(s => s.id === id ? { ...s, ...payload } : s));
      flash('Section saved ✓');
    } catch (err) { flash(`❌ Save error: ${err.message}`); }
  };

  const toggleApproval = async (section) => {
    const next = !section.approved;
    try {
      await updateDoc(doc(db, 'psm_sections', section.id), { approved: next });
      setSections(prev => prev.map(s => s.id === section.id ? { ...s, approved: next } : s));
      flash(next ? 'Section approved ✓' : 'Approval revoked');
    } catch (err) { flash(`❌ Approval error: ${err.message}`); }
  };

  const handleApproveAllFiltered = async () => {
    const targetCount = pendingFilteredSections.length;
    if (targetCount === 0) { flash('No pending sections found to approve.'); return; }
    const confirmMsg = searchTerm
      ? `Approve all ${targetCount} pending sections matching "${searchTerm}"?`
      : `Approve all ${targetCount} pending sections in the knowledge base?`;
    if (!window.confirm(confirmMsg)) return;
    setIsBulkApproving(true);
    flash(`⏳ Approving ${targetCount} items in optimal chunks...`);
    try {
      const chunkSize = 400;
      const targetIds = pendingFilteredSections.map(s => s.id);
      for (let i = 0; i < targetIds.length; i += chunkSize) {
        const batch = writeBatch(db);
        targetIds.slice(i, i + chunkSize).forEach(id => {
          batch.update(doc(db, 'psm_sections', id), { approved: true });
        });
        await batch.commit();
      }
      setSections(prev => prev.map(s => targetIds.includes(s.id) ? { ...s, approved: true } : s));
      flash(`✅ Successfully approved ${targetCount} sections!`);
    } catch (err) { flash(`❌ Bulk approval failed: ${err.message}`); }
    finally { setIsBulkApproving(false); }
  };

  const handleDeleteAllFiltered = async () => {
    const targetCount = filteredSections.length;
    if (targetCount === 0) { flash('No active database records found to target for deletion.'); return; }
    const firstConfirm = searchTerm
      ? `🚨 WARNING: You are about to permanently delete all ${targetCount} rows matching "${searchTerm}" from Firestore. Proceed?`
      : `🚨 CRITICAL WARNING: You are about to permanently delete ALL ${targetCount} documents in the database. This action is irreversible. Proceed?`;
    if (!window.confirm(firstConfirm)) return;
    if (!window.confirm("⚠️ Final confirmation: Are you completely sure you want to drop these data models? Your RAG vector database will clear upon the next compile phase.")) return;
    setIsBulkDeleting(true);
    flash(`⏳ Purging ${targetCount} database records in chunks...`);
    try {
      const chunkSize = 400;
      const targetIds = filteredSections.map(s => s.id);
      for (let i = 0; i < targetIds.length; i += chunkSize) {
        const batch = writeBatch(db);
        targetIds.slice(i, i + chunkSize).forEach(id => {
          batch.delete(doc(db, 'psm_sections', id));
        });
        await batch.commit();
      }
      setSections(prev => prev.filter(s => !targetIds.includes(s.id)));
      setSearchTerm('');
      flash(`🗑️ Successfully dropped ${targetCount} documents from Firestore.`);
    } catch (err) { flash(`❌ Bulk structural deletion failed: ${err.message}`); }
    finally { setIsBulkDeleting(false); }
  };

  const deleteSection = async (id) => {
    if (!window.confirm('Delete this section?')) return;
    try {
      await deleteDoc(doc(db, 'psm_sections', id));
      setSections(prev => prev.filter(s => s.id !== id));
      flash('Section deleted.');
    } catch (err) { flash(`❌ Delete error: ${err.message}`); }
  };

  const addSection = async () => {
    if (!newSection.page_title.trim() || !stripHtml(newSection.content)) {
      flash('Page title and content are required.');
      return;
    }
    const payload = {
      page_title:    newSection.page_title.trim(),
      page_url:      newSection.page_url.trim(),
      path:          newSection.path.trim(),
      heading:       newSection.heading.trim(),
      content:       normalizeNestedLists(newSection.content.trim()),
      picture_links: newSection.picture_links.split('\n').map(s => s.trim()).filter(Boolean),
      doc_links:     newSection.doc_links.split('\n').map(s => s.trim()).filter(Boolean),
      image_context: [],
      scraped_at:    new Date().toISOString(),
      approved:      false,
      createdAt:     serverTimestamp(),
    };
    try {
      const ref = await addDoc(collection(db, 'psm_sections'), payload);
      setSections(prev => [...prev, { id: ref.id, ...payload }]);
      setNewSection({ page_title: '', page_url: '', path: '', heading: '', content: '', picture_links: '', doc_links: '' });
      setShowAddForm(false);
      flash('Section added ✓');
    } catch (err) { flash(`❌ Add error: ${err.message}`); }
  };

  // ── AI pipeline SSE runner ──
  const runTask = async (task) => {
    if (genRunning) return;

    const endpoint = task === 'scrape' ? '/run-scraper' : '/run-rebuild';
    const label    = task === 'scrape' ? '🕷️ Web Scraper' : '🔄 Chroma Rebuild';

    // Fresh AbortController for this run — lets cancelTask() interrupt the fetch/stream
    const controller = new AbortController();
    abortControllerRef.current = controller;

    setGenRunning(true);
    setActiveTask(task);
    setGenLog([{ id: Date.now(), text: `🚀 Starting ${label}...`, type: 'info' }]);
    setGenProgress(0);

    try {
      const response = await fetch(`http://127.0.0.1:8000${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
      });

      if (!response.ok) throw new Error(`Server returned ${response.status}`);

      const reader  = response.body.getReader();
      const decoder = new TextDecoder();
      let   buffer  = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop(); // keep incomplete last line in buffer

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const text = line.slice(6).trim();
          if (!text) continue;

          if (text === '__DONE__') {
            setGenProgress(100);
            setGenRunning(false);
            setActiveTask(null);
            abortControllerRef.current = null;
            flash(`${label} finished ✓`);
            return;
          }

          // Derive progress from well-known log keywords
          setGenProgress(prev => {
            if (text.includes('Connecting to Firestore'))              return Math.max(prev, 10);
            if (text.includes('approved sections'))                    return Math.max(prev, 25);
            if (text.includes('text split'))                           return Math.max(prev, 40);
            if (text.includes('embedding model'))                      return Math.max(prev, 50);
            if (text.includes('Embedded batch'))                       return Math.max(prev, 60);
            if (text.includes('fingerprint'))                          return Math.max(prev, 80);
            if (text.includes('successfully') || text.includes('✅')) return Math.max(prev, 90);
            return prev;
          });

          // Colour-code by prefix
          const type =
            text.startsWith('❌') ? 'error' :
            text.startsWith('✅') ? 'ok'    :
            text.startsWith('⚠️') ? 'warn'  :
            (text.startsWith('🔄') || text.startsWith('📦') || text.startsWith('🧠')) ? 'info' :
            'log';

          setGenLog(prev => [...prev, { id: Date.now() + Math.random(), text, type }]);
        }
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        // Cancelled via cancelTask() — that function already logs/flashes, so stay quiet here
        return;
      }
      setGenLog(prev => [...prev, { id: Date.now(), text: `❌ ${err.message}`, type: 'error' }]);
      flash('Task failed.');
    } finally {
      setGenRunning(false);
      setActiveTask(null);
      abortControllerRef.current = null;
    }
  };

  // Cancels the running task: aborts the client-side fetch/stream immediately,
  // and also asks the backend to terminate the underlying process (best-effort).
  const cancelTask = async () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    try {
      await fetch('http://127.0.0.1:8000/cancel-task', { method: 'POST' });
    } catch (_) {
      // best effort — client already stopped listening regardless of backend response
    }
    setGenLog(prev => [...prev, { id: Date.now(), text: '🛑 Task cancelled by user.', type: 'warn' }]);
    setGenRunning(false);
    setActiveTask(null);
    abortControllerRef.current = null;
    flash('Task cancelled.');
  };

  // ─────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────
  return (
    <div className="admin-wrapper">
      <header className="admin-topbar">
        <div className="admin-logo"> UTM Admin Panel</div>
        <div className="admin-topbar-right">
          <span className="admin-user-email">{user?.displayName || user?.email}</span>
          {toggleTheme && (
            <button className="icon-btn" onClick={toggleTheme}>{theme === 'dark' ? '☀️' : '🌙'}</button>
          )}
          <button className="icon-btn" onClick={() => signOut(auth)} title="Sign out">🚪</button>
        </div>
      </header>

      {statusMsg && <div className="admin-status-bar">{statusMsg}</div>}

      <nav className="admin-tabs">
        <button className={`tab-btn ${activeTab === 'users' ? 'active' : ''}`} onClick={() => setActiveTab('users')}>👥 Users</button>
        <button className={`tab-btn ${activeTab === 'kb'    ? 'active' : ''}`} onClick={() => setActiveTab('kb')}>📚 Knowledge Base</button>
        <button className={`tab-btn ${activeTab === 'ai'    ? 'active' : ''}`} onClick={() => setActiveTab('ai')}>🤖 AI Generate</button>
      </nav>

      <main className="admin-main">

        {/* ══════════════════════════════════════════════
            USERS TAB
        ══════════════════════════════════════════════ */}
        {activeTab === 'users' && (
          <section className="admin-section">
            <div className="section-header">
              <div>
                <h2 className="section-title">System Users</h2>
                <div className="section-subtitle">Manage user roles and access levels</div>
              </div>
            </div>
            {usersLoading ? (
              <div className="admin-loading">Loading users...</div>
            ) : users.length === 0 ? (
              <div className="admin-empty">No users found.</div>
            ) : (
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>User / Email</th>
                    <th>Role</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map(u => (
                    <tr key={u.id}>
                      <td>{u.utm_gmail || u.email || '—'}</td>
                      <td>
                        <span className={`role-badge ${u.role === 'admin' ? 'role-admin' : 'role-user'}`}>
                          {u.role || 'user'}
                        </span>
                      </td>
                      <td>
                        {u.id === user?.uid ? (
                          <span className="self-label">Locked (Your Profile)</span>
                        ) : (
                          <button
                            className={u.role === 'admin' ? 'btn-demote' : 'btn-promote'}
                            onClick={() => toggleRole(u)}
                          >
                            {u.role === 'admin' ? '⏳ Set Standard User' : '✅ Promote to Admin'}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        )}

        {/* ══════════════════════════════════════════════
            KNOWLEDGE BASE TAB
        ══════════════════════════════════════════════ */}
        {activeTab === 'kb' && (
          <section className="admin-section">
            <div className="section-header">
              <div>
                <h2 className="section-title">Knowledge Base Sections</h2>
                <div className="section-subtitle">
                  {uniquePages} page{uniquePages !== 1 ? 's' : ''} · {sections.length} section{sections.length !== 1 ? 's' : ''}
                </div>
              </div>
              <button className="btn-primary" onClick={() => setShowAddForm(v => !v)}>
                {showAddForm ? '✕ Cancel' : '＋ Add Section'}
              </button>
            </div>

            {!sectionsLoading && sections.length > 0 && (
              <div className="stat-row" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '15px', marginBottom: '20px' }}>
                <div className="stat-card"><div className="stat-val">{uniquePages}</div><div className="stat-lbl">Crawled Pages</div></div>
                <div className="stat-card"><div className="stat-val">{sections.length}</div><div className="stat-lbl">Total Sections</div></div>
                <div className="stat-card"><div className="stat-val" style={{ color: '#2ec4b6' }}>{totalApproved}</div><div className="stat-lbl">Approved</div></div>
                <div className="stat-card"><div className="stat-val" style={{ color: '#ff9f1c' }}>{totalPending}</div><div className="stat-lbl">Pending</div></div>
                <div className="stat-card" style={{ borderLeft: '3px solid #7c3aed' }}>
                  <div className="stat-val" style={{ color: '#a78bfa' }}>{totalWithVision}</div>
                  <div className="stat-lbl">🔭 With Vision</div>
                </div>
                {searchTerm && (
                  <div className="stat-card" style={{ borderLeft: '3px solid var(--ai-accent, #7000ff)' }}>
                    <div className="stat-val" style={{ color: 'var(--ai-accent, #a855f7)' }}>{filteredSections.length}</div>
                    <div className="stat-lbl">Matches Found</div>
                  </div>
                )}
              </div>
            )}

            {/* Control Bar */}
            <div className="search-bar-wrapper" style={{ display: 'flex', gap: '12px', alignItems: 'center', marginBottom: '20px', width: '100%', flexWrap: 'wrap' }}>
              <div className="search-bar-container" style={{ flex: 1, minWidth: '240px', background: 'var(--bg-surface)', padding: '12px', borderRadius: '6px', display: 'flex', alignItems: 'center', gap: '10px', border: '1px solid var(--border)' }}>
                <span style={{ fontSize: '16px' }}>🔍</span>
                <input type="text" className="form-input"
                  placeholder="Search by title, heading, path, or content..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  style={{ margin: 0, width: '100%', background: 'transparent', border: 'none', color: 'var(--text-primary)', outline: 'none' }}
                />
                {searchTerm && (
                  <button onClick={() => setSearchTerm('')}
                    style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '13px', padding: '0 5px' }}>
                    ✕ Clear
                  </button>
                )}
              </div>

              <div style={{ display: 'flex', border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden', height: 45, flexShrink: 0 }}>
                <button onClick={() => setViewMode('nav')}
                  style={{ padding: '0 14px', fontSize: 12, fontWeight: 600, border: 'none', cursor: 'pointer', background: viewMode === 'nav' ? '#7c3aed' : 'var(--bg-surface)', color: viewMode === 'nav' ? '#fff' : 'var(--text-muted)', transition: 'background 0.15s' }}
                  title="Group by navigation menu">🗂 Nav Order</button>
                <button onClick={() => setViewMode('flat')}
                  style={{ padding: '0 14px', fontSize: 12, fontWeight: 600, border: 'none', borderLeft: '1px solid var(--border)', cursor: 'pointer', background: viewMode === 'flat' ? '#7c3aed' : 'var(--bg-surface)', color: viewMode === 'flat' ? '#fff' : 'var(--text-muted)', transition: 'background 0.15s' }}
                  title="Flat list">☰ Flat</button>
              </div>

              <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                {!sectionsLoading && pendingFilteredSections.length > 0 && (
                  <button className="btn-primary bulk-approve-btn" onClick={handleApproveAllFiltered}
                    disabled={isBulkApproving || isBulkDeleting}
                    style={{ height: '45px', whiteSpace: 'nowrap', padding: '0 16px', backgroundColor: '#2ec4b6', borderColor: '#2ec4b6', color: '#fff', opacity: isBulkApproving ? 0.6 : 1, cursor: isBulkApproving ? 'not-allowed' : 'pointer', borderRadius: '6px', fontWeight: 600, fontSize: '13px' }}>
                    {isBulkApproving ? '⏳ Processing...' : `✅ Approve All Pending (${pendingFilteredSections.length})`}
                  </button>
                )}
                {!sectionsLoading && filteredSections.length > 0 && (
                  <button className="bulk-delete-btn" onClick={handleDeleteAllFiltered}
                    disabled={isBulkApproving || isBulkDeleting}
                    style={{ height: '45px', whiteSpace: 'nowrap', padding: '0 16px', backgroundColor: '#e63946', border: '1px solid #e63946', color: '#fff', opacity: isBulkDeleting ? 0.6 : 1, cursor: isBulkDeleting ? 'not-allowed' : 'pointer', borderRadius: '6px', fontWeight: 600, fontSize: '13px', transition: 'background-color 0.2s' }}>
                    {isBulkDeleting ? '⏳ Purging...' : searchTerm ? `🗑️ Delete Filtered (${filteredSections.length})` : `🗑️ Delete All Data (${filteredSections.length})`}
                  </button>
                )}
              </div>
            </div>

            {showAddForm && (
              <div className="add-form-card">
                <h3 style={{ fontSize: 13, fontWeight: 600 }}>New Section</h3>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  <input className="form-input" placeholder="Page title…"   value={newSection.page_title} onChange={e => setNewSection(p => ({ ...p, page_title: e.target.value }))} />
                  <input className="form-input" placeholder="Section heading (optional)…" value={newSection.heading} onChange={e => setNewSection(p => ({ ...p, heading: e.target.value }))} />
                  <input className="form-input" placeholder="Page URL…"     value={newSection.page_url}  onChange={e => setNewSection(p => ({ ...p, page_url: e.target.value }))} />
                  <input className="form-input" placeholder="Path (e.g. /psm/about/)…" value={newSection.path} onChange={e => setNewSection(p => ({ ...p, path: e.target.value }))} />
                </div>
                <div style={{ marginTop: 4 }}>
                  <RichTextEditor
                    value={newSection.content}
                    onChange={(html) => setNewSection(p => ({ ...p, content: html }))}
                    minHeight={220}
                    placeholder="Content…"
                  />
                </div>
                <textarea className="form-textarea" placeholder="Picture links (one per line)…" rows={2} value={newSection.picture_links} onChange={e => setNewSection(p => ({ ...p, picture_links: e.target.value }))} />
                <textarea className="form-textarea" placeholder="Document links (one per line)…" rows={2} value={newSection.doc_links} onChange={e => setNewSection(p => ({ ...p, doc_links: e.target.value }))} />
                <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '4px 0 0' }}>
                  ℹ️ AI Vision Context is generated automatically by the scraper — not available for manual entries.
                </p>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn-primary" onClick={addSection}>💾 Save Section</button>
                  <button className="btn-ghost"   onClick={() => setShowAddForm(false)}>Cancel</button>
                </div>
              </div>
            )}

            {sectionsLoading ? (
              <div className="admin-loading">Loading sections...</div>
            ) : filteredSections.length === 0 ? (
              <div className="admin-empty">
                {sections.length === 0
                  ? "No sections found. Run the scraper or add one manually."
                  : "No data rows match your search criteria."}
              </div>
            ) : viewMode === 'nav' ? (
              <div>
                {navGroups.map(group => (
                  <NavGroup key={group.label} label={group.label} navIndex={group.navIndex}
                    sections={group.sections} onSave={saveSection} onDelete={deleteSection} onToggleApproval={toggleApproval} />
                ))}
              </div>
            ) : (
              <div className="kb-list">
                <div className="kb-list-head">
                  <span /><span className="kb-list-head-cell">Page Title</span>
                  <span className="kb-list-head-cell">Heading</span>
                  <span className="kb-list-head-cell">Path</span>
                  <span className="kb-list-head-cell" style={{ textAlign: 'center' }}>Status</span>
                  <span />
                </div>
                {filteredSections.map(section => (
                  <KbRow key={section.id} section={section} onSave={saveSection} onDelete={deleteSection} onToggleApproval={toggleApproval} />
                ))}
              </div>
            )}
          </section>
        )}

        {/* ══════════════════════════════════════════════
            AI GENERATE TAB
        ══════════════════════════════════════════════ */}
        {activeTab === 'ai' && (
          <section className="admin-section">

            <div className="ai-hero">
              <div className="ai-hero-title">🤖 AI Pipeline Control Centre</div>
              <p className="ai-hero-desc">
                Run the web scraper to collect fresh data, or rebuild the Chroma
                vector database from currently approved Firestore sections.
                All output streams live below.
              </p>

              <div className="ai-steps">
                <div className="ai-step">
                  <div className="ai-step-num">Step 1</div>
                  <div className="ai-step-text">Run <code>scraper.py</code> to crawl the PSM website and push raw sections into Firestore.</div>
                </div>
                <div className="ai-step">
                  <div className="ai-step-num">Step 2</div>
                  <div className="ai-step-text">Approve scraped sections in the <strong>Knowledge Base</strong> tab.</div>
                </div>
                <div className="ai-step">
                  <div className="ai-step-num">Step 3</div>
                  <div className="ai-step-text">Rebuild the Chroma DB — only approved sections are vectorized.</div>
                </div>
              </div>

              {/* Action Buttons */}
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: '1rem' }}>

                <button className="btn-ai" onClick={() => runTask('scrape')} disabled={genRunning}
                  style={{
                    background: activeTask === 'scrape' ? 'var(--bg-input)' : 'linear-gradient(135deg, #ff9f1c, #ffbf69)',
                    color: activeTask === 'scrape' ? 'var(--text-muted)' : '#0f1117',
                    border: 'none', padding: '10px 20px', borderRadius: 8,
                    fontWeight: 700, fontSize: 13,
                    cursor: genRunning ? 'not-allowed' : 'pointer',
                    opacity: genRunning && activeTask !== 'scrape' ? 0.45 : 1,
                    transition: 'opacity 0.2s',
                  }}>
                  {activeTask === 'scrape' ? '⏳ Scraping…' : '🕷️ Run Web Scraper'}
                </button>

                <button className="btn-ai" onClick={() => runTask('rebuild')} disabled={genRunning}
                  style={{
                    background: activeTask === 'rebuild' ? 'var(--bg-input)' : 'var(--ai-accent, linear-gradient(135deg, #7c3aed, #2563eb))',
                    color: activeTask === 'rebuild' ? 'var(--text-muted)' : '#fff',
                    border: 'none', padding: '10px 20px', borderRadius: 8,
                    fontWeight: 700, fontSize: 13,
                    cursor: genRunning ? 'not-allowed' : 'pointer',
                    opacity: genRunning && activeTask !== 'rebuild' ? 0.45 : 1,
                    transition: 'opacity 0.2s',
                  }}>
                  {activeTask === 'rebuild' ? '⏳ Rebuilding…' : '🔄 Rebuild Chroma DB'}
                </button>

                {genRunning && (
                  <button onClick={cancelTask}
                    style={{
                      background: '#e63946',
                      color: '#fff',
                      border: 'none',
                      padding: '10px 20px',
                      borderRadius: 8,
                      fontWeight: 700,
                      fontSize: 13,
                      cursor: 'pointer',
                    }}>
                    ✕ Cancel Task
                  </button>
                )}

                {genLog.length > 0 && !genRunning && (
                  <button onClick={() => { setGenLog([]); setGenProgress(0); }}
                    style={{ background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-muted)', padding: '10px 16px', borderRadius: 8, fontWeight: 600, fontSize: 12, cursor: 'pointer' }}>
                    ✕ Clear Log
                  </button>
                )}
              </div>

              {/* Progress Bar */}
              {(genRunning || genProgress > 0) && (
                <div style={{ marginTop: 16 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-muted)', marginBottom: 5 }}>
                    <span>{genRunning ? (activeTask === 'scrape' ? '🕷️ Scraper running...' : '🔄 Rebuilding vector DB...') : '✅ Done'}</span>
                    <span>{genProgress}%</span>
                  </div>
                  <div className="ai-progress-wrap">
                    <div className="ai-progress-bar" style={{
                      width: `${genProgress}%`,
                      background: activeTask === 'scrape'
                        ? 'linear-gradient(90deg, #ff9f1c, #ffbf69)'
                        : 'linear-gradient(90deg, #7c3aed, #2563eb)',
                      transition: 'width 0.4s ease',
                    }} />
                  </div>
                </div>
              )}
            </div>

            {/* Live Log Terminal */}
            {genLog.length > 0 && (
              <div className="ai-log" style={{
                maxHeight: 420, overflowY: 'auto', fontFamily: 'monospace', fontSize: 12,
                background: 'var(--bg-surface)', border: '1px solid var(--border)',
                borderRadius: 8, padding: '12px 16px', marginTop: 16,
              }}>
                {genLog.map(line => (
                  <div key={line.id} className={`ai-log-line ${line.type}`}
                    style={{
                      color:
                        line.type === 'error' ? '#ef4444' :
                        line.type === 'ok'    ? '#2ec4b6' :
                        line.type === 'warn'  ? '#ff9f1c' :
                        line.type === 'info'  ? '#a78bfa' :
                        'var(--text-secondary)',
                      padding: '2px 0', lineHeight: 1.6,
                      display: 'flex', gap: 8, alignItems: 'flex-start',
                    }}>
                    <div className={`log-dot ${line.type}`} style={{
                      width: 6, height: 6, borderRadius: '50%', marginTop: 6, flexShrink: 0,
                      background:
                        line.type === 'error' ? '#ef4444' :
                        line.type === 'ok'    ? '#2ec4b6' :
                        line.type === 'warn'  ? '#ff9f1c' :
                        line.type === 'info'  ? '#a78bfa' :
                        'var(--border-hover)',
                    }} />
                    <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{line.text}</span>
                  </div>
                ))}
                <div ref={logEndRef} /> {/* auto-scroll anchor */}
              </div>
            )}

            {!genRunning && genLog.length === 0 && (
              <p className="admin-empty" style={{ marginTop: 16 }}>
                Pipeline idle. Select a task above to begin.
              </p>
            )}

          </section>
        )}

      </main>
    </div>
  );
}

// Toggle to light mode
document.documentElement.setAttribute('data-theme', 'light');

// Switch back to dark mode
document.documentElement.removeAttribute('data-theme');