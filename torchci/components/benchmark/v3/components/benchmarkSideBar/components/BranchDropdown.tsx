import { Box } from "@mui/system";
import { UMDenseDropdown } from "components/uiModules/UMDenseComponents";
import { DenseAlert } from "../../common/styledComponents";

type BranchDropdownsProps = {
  type: string;
  lbranch: string;
  rbranch: string;
  setLbranch: (val: string) => void;
  setRbranch: (val: string) => void;
  branchOptions?: string[];
};

/**
 *
 * BranchDropdown UI component
 * @param {string} type - type of the dropdown, can be "comparison" or "single".
 * @param {string} lBranch - left branch
 * @param {string} rBranch - right branch
 * @param {function} setLBranch - set left branch
 * @param {function} setRBranch - set right branch
 *
 * @returns
 */
const SectionShell: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => (
  <Box
    sx={{
      width: 1, // fill parent width
      minWidth: 0, // IMPORTANT in flex layouts to allow wrapping
      display: "grid", // keeps children from affecting width
      gap: 1,
    }}
  >
    {children}
  </Box>
);

export function BranchDropdowns({
  type,
  lbranch,
  rbranch,
  setLbranch,
  setRbranch,
  branchOptions,
}: BranchDropdownsProps) {
  const empty = !branchOptions || branchOptions.length === 0;

  return (
    <SectionShell>
      {empty ? (
        <DenseAlert severity="warning">
          No branch is found, please select other features.
        </DenseAlert>
      ) : type === "comparison" ? (
        <>
          <UMDenseDropdown
            dtype={lbranch}
            setDType={setLbranch}
            dtypes={branchOptions}
            label="Left Branch"
          />
          <UMDenseDropdown
            dtype={rbranch}
            setDType={setRbranch}
            dtypes={branchOptions}
            label="Right Branch"
          />
        </>
      ) : (
        <UMDenseDropdown
          dtype={lbranch}
          setDType={(val: string) => {
            setLbranch(val);
            setRbranch(val);
          }}
          dtypes={branchOptions}
          label="Branch"
        />
      )}
    </SectionShell>
  );
}
