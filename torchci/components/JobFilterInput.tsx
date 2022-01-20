export default function JobFilterInput({
  currentFilter,
  handleSubmit,
  handleInput,
  width,
}: {
  currentFilter: string | null;
  handleSubmit: () => void;
  handleInput: (value: string) => void;
  width?: string;
}) {
  return (
    <div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          handleSubmit();
        }}
      >
        <label htmlFor="name_filter">
          Job filter: (press enter to change url, esc to clear):{" "}
        </label>
        <input
          style={{ width: width }}
          onChange={(e) => {
            handleInput(e.currentTarget.value);
          }}
          type="search"
          name="name_filter"
          value={currentFilter || ""}
        />
        <input type="submit" value="Go" />
      </form>
    </div>
  );
}
