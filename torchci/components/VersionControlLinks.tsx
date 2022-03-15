export default function VersionControlLinks({
  sha,
  diffNum,
}: {
  sha: string;
  diffNum: string | null;
}) {
  return (
    <div>
      <a href={`https://github.com/pytorch/pytorch/commit/${sha}`}>GitHub</a>
      {typeof diffNum === "string" ? (
        <span>
          {" "}
          |{" "}
          <a href={`https://www.internalfb.com/diff/${diffNum}`}>Phabricator</a>
        </span>
      ) : null}
    </div>
  );
}
