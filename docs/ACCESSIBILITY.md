# Accessibility

Target: WCAG 2.2 AA for the desktop/web interface.

Required behaviour includes complete keyboard operation, logical focus order, visible focus, semantic headings/landmarks, labelled controls, accessible menus/dialogs, status text beyond colour, sufficient contrast, reduced motion, zoom/font scaling, high-contrast compatibility, and linked validation errors. Every drag operation requires an equivalent move command accessible by keyboard and assistive technology.

The editor keyboard map must document page switching/creation, block selection and multi-selection, movement, indent/outdent, duplicate/delete, undo/redo, task toggle, links, Escape behaviour, arrows, and Tab focus. Shortcuts must eventually be configurable and must not trap browser or screen-reader navigation.

Validation requires automated semantic/contrast checks plus manual keyboard-only, zoom, reduced-motion, high-contrast, and screen-reader passes on Linux, Windows, and macOS. Automated checks are not acceptance by themselves.

The current web slice includes responsive styling, focus treatment, labels, and keyboard search. It has not completed a WCAG audit, screen-reader validation, full editor keyboard model, or accessible drag alternatives.
