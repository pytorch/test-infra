import { Alert } from "@mui/material";
import { Box } from "@mui/system";
import { UMDenseDropdown } from "components/uiModules/UMDenseComponents";

type BranchDropdownsProps = {
  type: string;
  lBranch: string;
  rBranch: string;
  setLBranch: (val: string) => void;
  setRBranch: (val: string) => void;
  branchOptions?: string[];
};

const styles = {
  missingBranch: {
    width: 1,
    wordBreak: "break-word",
    whiteSpace: "normal",
    padding: 0.2,
    // ↓ shrink the text inside the Alert
    "& .MuiAlert-message": {
      fontSize: "0.7rem", // ~13px
      lineHeight: 1.4,
    },

    // (optional) shrink the icon to match the smaller text
    "& .MuiAlert-icon": {
      padding: 0.8, // tighten spacing
      "& svg": { fontSize: 20 },
    },
  },
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
  lBranch,
  rBranch,
  setLBranch,
  setRBranch,
  branchOptions,
}: BranchDropdownsProps) {
  const empty = !branchOptions || branchOptions.length === 0;

  return (
    <SectionShell>
      {empty ? (
        <Alert severity="warning" sx={styles.missingBranch}>
          No branch is found, please select other features.
        </Alert>
      ) : type === "comparison" ? (
        <>
          <UMDenseDropdown
            dtype={lBranch}
            setDType={setLBranch}
            dtypes={branchOptions}
            label="Left Branch"
          />
          <UMDenseDropdown
            dtype={rBranch}
            setDType={setRBranch}
            dtypes={branchOptions}
            label="Right Branch"
          />
        </>
      ) : (
        <UMDenseDropdown
          dtype={lBranch}
          setDType={(val: string) => {
            setLBranch(val);
            setRBranch(val);
          }}
          dtypes={branchOptions}
          label="Branch"
        />
      )}
    </SectionShell>
  );
}
