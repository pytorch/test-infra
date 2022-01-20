import { JobData } from "lib/types";
import { useEffect, useState } from "react";
import useSWRImmutable from "swr";
import Editor, { useMonaco } from "@monaco-editor/react";
import { Monaco } from "@monaco-editor/react";
import styles from "./LogViewer.module.css";

function filterLog(log: string): string {
  let negativeRegexes = [
    /Z Entering 'third_party/,
    /Z http\.https:\/\/github\.com\/\.extraheader/,
    /Z deleted: sha256/,
    /Z untagged: sha256/,
    /Z untagged: .*amazonaws/,
    /Z \s*adding: /,
    /Z \s*creating: /,
    /Z \s*inflating: /,
    /Z \s*extracting: /,
    /Z adding /,
    /Z copying /,
    /Z creating /,
    /Z refs\/remotes\/origin/,
    /Z Synchronizing submodule url for/,
    /Z Receiving objects:/,
    /Z Resolving deltas:/,
    /Z remote: Compressing objects:/,
    /Z Submodule path /,
    /Z remote: Counting objects:/,
    /Z [a-z0-9]{12}: Waiting/,
    /Z [a-z0-9]{12}: Pulling fs layer/,
    /Z [a-z0-9]{12}: Verifying Checksum/,
    /Z [a-z0-9]{12}: Download complete/,
    /Z [a-z0-9]{12}: Pull complete/,
    /Z url\.https:\/\/github\.com/,
    /Z Generating XML reports/,
    /Z Generated XML report/,
    /Z Test results will be stored/,
  ];

  const lines = log.split("\n");
  let newLog = "";

  for (const line of lines) {
    let include = true;
    for (const regex of negativeRegexes) {
      if (line.match(regex)) {
        include = false;
        break;
      }
    }
    if (include) {
      newLog += line + "\n";
    }
  }
  return newLog;
}

function registerLogLanguage(monaco: Monaco) {
  // Register a new language
  monaco.languages.register({ id: "logText" });

  // Register a tokens provider for the language
  monaco.languages.setMonarchTokensProvider("logText", {
    tokenizer: {
      root: [
        [/\[30;1m.*?\[0m/, "black"],
        [/\[31;1m.*?\[0m/, "red"],
        [/\[32;1m.*?\[0m/, "green"],
        [/\[33;1m.*?\[0m/, "yellow"],
        [/\[34;1m.*?\[0m/, "blue"],
        [/\[35;1m.*?\[0m/, "magenta"],
        [/\[36;1m.*?\[0m/, "cyan"],
        [/\[37;1m.*?\[0m/, "white"],

        [/\[30m.*?\[0m/, "black"],
        [/\[31m.*?\[0m/, "red"],
        [/\[32m.*?\[0m/, "green"],
        [/\[33m.*?\[0m/, "yellow"],
        [/\[34m.*?\[0m/, "blue"],
        [/\[35m.*?\[0m/, "magenta"],
        [/\[36m.*?\[0m/, "cyan"],
        [/\[37m.*?\[0m/, "white"],

        [/\[0;1;30m.*?\[0m/, "black"],
        [/\[0;1;31m.*?\[0m/, "red"],
        [/\[0;1;32m.*?\[0m/, "green"],
        [/\[0;1;33m.*?\[0m/, "yellow"],
        [/\[0;1;34m.*?\[0m/, "blue"],
        [/\[0;1;35m.*?\[0m/, "magenta"],
        [/\[0;1;36m.*?\[0m/, "cyan"],
        [/\[0;1;37m.*?\[0m/, "white"],

        [/\[1m.*?\[0m/, "cyan"],
        [/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{7}Z/, "hidden"],
      ],
    },
  });

  // Define a new theme that contains only rules that match this language
  monaco.editor.defineTheme("logTheme", {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "black", foreground: "000000", fontStyle: "bold" },
      { token: "red", foreground: "af0000", fontStyle: "bold" },
      { token: "green", foreground: "87d700", fontStyle: "bold" },
      { token: "yellow", foreground: "d7d700", fontStyle: "bold" },
      { token: "blue", foreground: "5fd7ff", fontStyle: "bold" },
      { token: "magenta", foreground: "8700af", fontStyle: "bold" },
      { token: "cyan", foreground: "00af87", fontStyle: "bold" },
      { token: "white", foreground: "ffffff", fontStyle: "bold" },
      { token: "hidden", foreground: "5f5f5f" },
    ],
    colors: {},
  });

  monaco.languages.registerFoldingRangeProvider("logText", {
    provideFoldingRanges: function (model, context, token) {
      const lines = model.getValue().split("\n");
      const starts = [];
      const ends = [];
      let lineNumber = 0;
      for (const line of lines) {
        if (line.includes("##[group]")) {
          starts.push(lineNumber);
        } else if (line.includes("##[endgroup]")) {
          ends.push(lineNumber);
        }
        lineNumber += 1;
      }
      let ranges = [];
      for (let i = 0; i < Math.min(starts.length, ends.length); i++) {
        ranges.push({
          start: starts[i] + 1,
          end: ends[i] + 1,
          kind: monaco.languages.FoldingRangeKind.Imports,
        });
      }
      return ranges;
    },
  });
}

const fetcher = (url: string) => fetch(url).then((res) => res.text());
function Log({ url, line }: { url: string; line: number }) {
  const monaco = useMonaco();

  useEffect(() => {
    monaco?.languages.typescript.javascriptDefaults.setEagerModelSync(true);
  }, [monaco]);
  const { data } = useSWRImmutable(url, fetcher);

  if (data === undefined) {
    return (
      <div>
        <em>loading...</em>
      </div>
    );
  }

  return (
    <Editor
      height="90vh"
      defaultLanguage="logText"
      defaultValue={data}
      theme="logTheme"
      beforeMount={(monaco) => registerLogLanguage(monaco)}
      line={line}
      options={{
        scrollBeyondLastLine: false,
        lineNumbersMinChars: 6,
        readOnly: true,
        minimap: { enabled: false },
      }}
      onMount={(editor, monaco) => {
        editor.deltaDecorations(
          [],
          [
            {
              range: {
                startLineNumber: line,
                endLineNumber: line,
                startColumn: 1,
                endColumn: 1,
              },
              options: {
                isWholeLine: true,
                className: styles.highlightLogLine,
              },
            },
          ]
        );
        let foldAction = editor.getAction("editor.foldAll");
        foldAction.run().then(() => {
          editor.revealLineInCenter(line);
        });
      }}
    />
  );
}

export default function LogViewer({ job }: { job: JobData }) {
  const [showLogViewer, setShowLogViewer] = useState(false);
  if (job.failureLine == null) {
    return null;
  }

  function handleClick() {
    setShowLogViewer(!showLogViewer);
  }

  return (
    <div>
      <details>
        <summary>
          <code style={{ cursor: "pointer" }} onClick={handleClick}>
            {job.failureLine}
          </code>
        </summary>
        {showLogViewer && (
          <Log url={job.logUrl!} line={job.failureLineNumber!} />
        )}
      </details>
    </div>
  );
}
