import { UMDenseDropdown } from "components/uiModules/UMDenseComponents";

type BranchDropdownsProps = {
  type: string;
  lBranch: string;
  rBranch: string;
  setLBranch: (val: string) => void;
  setRBranch: (val: string) => void;
  branchOptions?: string[];
};

export function BranchDropdowns({
  type,
  lBranch,
  rBranch,
  setLBranch,
  setRBranch,
  branchOptions,
}: BranchDropdownsProps) {
  if (branchOptions?.length == 0) {
    return <div>No branch is found, please select other features.</div>;
  }
  switch (type) {
    case "comparison":
      return (
        <>
          <UMDenseDropdown
            dtype={lBranch}
            setDType={setLBranch}
            dtypes={branchOptions ?? []}
            label="Left Branch"
          />
          <UMDenseDropdown
            dtype={rBranch}
            setDType={setRBranch}
            dtypes={branchOptions ?? []}
            label="Right Branch"
          />
        </>
      );

    default:
      return (
        <UMDenseDropdown
          dtype={lBranch}
          setDType={(val: string) => {
            setLBranch(val);
            setRBranch(val); // sync both
          }}
          dtypes={branchOptions ?? []}
          label="Branch"
        />
      );
  }
}
