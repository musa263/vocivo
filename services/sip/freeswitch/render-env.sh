#!/bin/sh
# Escape XML first, then the sed replacement language. Never evaluate values.
render_value() {
  case "$1" in *[[:cntrl:]]*) echo "Vocivo: control character in configuration rejected" >&2; return 1;; esac
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g' -e "s/'/\&apos;/g" | sed 's/[\\&#]/\\&/g'
}
