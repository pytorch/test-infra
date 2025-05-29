import Link from "next/link";
import { FaLink } from "react-icons/fa";
export const UMSymlink = ({ target }: { target: string }) => (
  <div>
    <Link href={target} target="_blank" rel="noopener noreferrer">
      <FaLink />
    </Link>
  </div>
);
