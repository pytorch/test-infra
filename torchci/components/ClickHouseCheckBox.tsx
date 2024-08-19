export function ClickHouseCheckBox({
  useClickHouse,
  setUseClickHouse,
}: {
  useClickHouse: boolean;
  setUseClickHouse: any;
}) {
  return (
    <>
      <div>
        <span
          onClick={() => {
            setUseClickHouse(!useClickHouse);
          }}
        >
          <input
            type="checkbox"
            name="useClickHouse"
            checked={useClickHouse}
            onChange={() => {}}
          />
          <label htmlFor="useClickHouse"> Use ClickHouse</label>
        </span>
      </div>
    </>
  );
}
