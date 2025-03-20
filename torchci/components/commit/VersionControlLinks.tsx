export default function VersionControlLinks({
  githubUrl,
  diffNum,
}: {
  githubUrl: string;
  diffNum: string | null;
}) {
  return (
    <div>
      <a href={`${githubUrl}`}>GitHub</a>
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
