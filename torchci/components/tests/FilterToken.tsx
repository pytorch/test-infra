import TextButton from "components/tests/TextButton";
import type { Token } from "lib/tests/environment";

export interface FilterTokenProps {
  token: Token;
  onFilter: (_filters: Token["filters"]) => void;
}

// A value in a cell that is also a filter: clicking it narrows the table to
// the rows with this value, by way of the column's header filter. A token
// that is short for something, a workflow's name, shows the whole on hover.
export default function FilterToken({ token, onFilter }: FilterTokenProps) {
  return (
    <TextButton
      label={
        token.tooltip === undefined
          ? `Only ${token.text}`
          : `Only ${token.text}, ${token.tooltip}`
      }
      tooltip={token.tooltip}
      onClick={() => onFilter(token.filters)}
    >
      {token.text}
    </TextButton>
  );
}
