import { SUITES } from "components/benchmark/compilers/SuitePicker";

export function LogLinks({ suite, logs }: { suite: string; logs: any }) {
  if (!logs) {
    return <></>;
  }

  return (
    <>
      {" "}
      {SUITES[suite]} (
      {logs.map((log: any) => (
        <a key={log.url} href={log.url}>
          #{log.index}
          {log.index === log.total ? "" : ", "}
        </a>
      ))}
      )
    </>
  );
}
