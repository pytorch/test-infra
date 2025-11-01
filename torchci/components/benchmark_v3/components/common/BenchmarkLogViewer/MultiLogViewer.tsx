import { basicSetup } from "@codemirror/basic-setup";
import { codeFolding, foldAll } from "@codemirror/language";
import { search } from "@codemirror/search";
import { EditorState } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import { EditorView } from "@codemirror/view";
import { foldUninteresting } from "components/common/log/LogViewer";
import { useEffect, useMemo, useRef } from "react";

type Props = {
  doc: string;
  height?: string | number;
  width?: string | number;
  extraExtensions?: any[];
  autoFoldOnMount?: boolean;
  viewRef?: React.MutableRefObject<EditorView | null>;
};

export function MultiLogViewer({
  doc,
  height = "90vh",
  width = "100%",
  extraExtensions = [],
  autoFoldOnMount = true,
  viewRef, // <- no forwardRef; just a prop
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const localViewRef = useRef<EditorView | null>(null);

  const state = useMemo(() => {
    return EditorState.create({
      doc,
      extensions: [
        basicSetup,
        EditorState.readOnly.of(true),
        EditorView.theme({
          "&": { width: "100%", height: "100%", boxSizing: "border-box" },
          ".cm-activeLine": { backgroundColor: "indigo" },
          "&.cm-focused .cm-selectionBackground": {
            backgroundColor: "indigo",
          },
        }),
        oneDark,
        foldUninteresting,
        codeFolding({
          placeholderText:
            "<probably uninteresting folded group, click to show>",
        }),
        search({ top: true }),
        ...extraExtensions,
      ],
    });
  }, [doc, extraExtensions]);

  // mount / update
  useEffect(() => {
    const parentEl = containerRef.current;
    if (!parentEl) return;

    if (!localViewRef.current) {
      const v = new EditorView({ state, parent: parentEl });
      localViewRef.current = v;
      // mirror into parent ref if provided
      if (viewRef) viewRef.current = v;
      if (autoFoldOnMount) foldAll(v);
    } else {
      localViewRef.current.setState(state);
    }
  }, [state, autoFoldOnMount, viewRef]);

  // cleanup
  useEffect(() => {
    return () => {
      localViewRef.current?.destroy();
      if (viewRef) viewRef.current = null;
      localViewRef.current = null;
    };
  }, [viewRef]);

  return (
    <div
      ref={containerRef}
      style={{ width, height, minWidth: 0, overflow: "hidden" }}
      onDoubleClick={(e) => e.stopPropagation()}
    />
  );
}
