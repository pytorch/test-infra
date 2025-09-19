import {
  closestCenter,
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Check, CopyAll, DragHandle } from "@mui/icons-material";
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  List,
  ListItem,
  ListItemButton,
  Stack,
  Typography,
} from "@mui/material";
import { ValidatedTextField } from "components/common/ValidatedTextField";
import { getDefaultGroupSettings } from "components/HudGroupingSettings/defaults";
import * as React from "react";
import { useState } from "react";
import {
  getNonDupNewName,
  getStoredTreeData,
  Group,
  isDupName,
  parseTreeData,
  saveTreeData,
  serializeTreeData,
} from "./mainPageSettingsUtils";

function validRegex(value: string) {
  try {
    new RegExp(value);
    return true;
  } catch (e) {
    return false;
  }
}

// MARK: Default Components

function FormStack({
  children,
  onSubmit,
}: {
  children: React.ReactNode;
  onSubmit: (e: React.FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <Stack
      spacing={2}
      component="form"
      noValidate
      autoComplete="off"
      sx={{
        "& .MuiTextField-root": {
          marginRight: 1,
          width: "25ch",
        },
        "& .MuiButton-root": {
          marginTop: 1,
          marginBottom: 1,
          marginLeft: 2,
        },
      }}
      onSubmit={onSubmit}
    >
      {children}
    </Stack>
  );
}

function DefaultOpenDialogButton({
  text,
  setOpen,
}: {
  text: string;
  setOpen: (open: boolean) => void;
}) {
  return (
    <Button
      onClick={() => {
        setOpen(true);
      }}
    >
      {text}
    </Button>
  );
}

function DefaultDialog({
  open,
  setOpen,
  children,
}: {
  open: boolean;
  setOpen: (open: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <Dialog
      open={open}
      closeAfterTransition={false}
      onClose={() => setOpen(false)}
      aria-modal
    >
      <DialogContent>{children}</DialogContent>
    </Dialog>
  );
}

// MARK: Specific Dialogs

function ImportExportDialog({
  treeData,
  setTreeData,
}: {
  treeData: Group[];
  setTreeData: (data: Group[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [justClicked, setJustClicked] = useState(false);

  return (
    <>
      <DefaultOpenDialogButton text="Import/Export" setOpen={setOpen} />
      <DefaultDialog open={open} setOpen={setOpen}>
        <Stack spacing={2}>
          {/* Copy current */}
          <Button
            onClick={() => {
              navigator.clipboard.writeText(serializeTreeData(treeData));
              // Set icon to check for 1.5 seconds
              setJustClicked(true);
              setTimeout(() => setJustClicked(false), 1500);
            }}
          >
            {justClicked ? <Check /> : <CopyAll />}
            Click to copy current settings
          </Button>
          <FormStack
            onSubmit={(e) => {
              e.preventDefault();
              const data = new FormData(e.currentTarget);
              const value = data.get("Import");
              const revived = parseTreeData(value as string);
              if (revived === undefined) {
                return;
              }
              setTreeData(revived);
              setOpen(false);
            }}
          >
            <ValidatedTextField
              name="Import"
              isValid={(v) => parseTreeData(v) !== undefined}
              initialValue=""
              errorMessage="Invalid import"
            />
            <DialogActions>
              <Button type="submit">Save and Close</Button>
            </DialogActions>
          </FormStack>
        </Stack>
      </DefaultDialog>
    </>
  );
}

function EditSectionDialog({
  treeData,
  name,
  setGroup,
}: {
  treeData: Group[];
  name: string;
  setGroup: (name: string, newName: string, regex: string) => void;
}) {
  const [open, setOpen] = useState(false);

  function isGoodName(value: string) {
    return value == name || !isDupName(treeData, value);
  }

  return (
    <>
      <DefaultOpenDialogButton text="Edit" setOpen={setOpen} />
      <DefaultDialog open={open} setOpen={setOpen}>
        <FormStack
          onSubmit={(e) => {
            e.preventDefault();
            const formData = new FormData(e.currentTarget);
            const regex = formData.get("Filter") as string;
            const newName = formData.get("Section name") as string;
            if (!validRegex(regex) || !isGoodName(newName)) {
              return;
            }
            setGroup(name, newName, regex);
            setOpen(false);
          }}
        >
          <ValidatedTextField
            name="Section name"
            isValid={isGoodName}
            initialValue={name}
            errorMessage="Cannot have duplicate names"
          />
          <ValidatedTextField
            name="Filter"
            isValid={validRegex}
            initialValue={
              treeData.find((node) => node.name === name)?.regex.source ?? ""
            }
            errorMessage="Invalid regex"
          />
          <DialogActions>
            <Button type="submit">Save and Close</Button>
          </DialogActions>
        </FormStack>
      </DefaultDialog>
    </>
  );
}

function ResetButton({ onConfirm }: { onConfirm: () => void }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <DefaultOpenDialogButton text="Reset" setOpen={setOpen} />
      <DefaultDialog open={open} setOpen={setOpen}>
        <Stack spacing={2}>
          <Typography>
            Are you sure you want to reset to default group settings?
          </Typography>
          <Stack direction="row" spacing={2}>
            <Button
              onClick={() => {
                onConfirm();
                setOpen(false);
              }}
              color="error"
            >
              Yes
            </Button>
            <Button
              onClick={() => {
                setOpen(false);
              }}
            >
              No
            </Button>
          </Stack>
        </Stack>
      </DefaultDialog>
    </>
  );
}

// MARK: Main Component

export default function SettingsModal({
  repositoryFullName,
  branchName,
  visible,
  handleClose,
}: {
  repositoryFullName: string;
  branchName: string;
  visible: boolean;
  handleClose: () => void;
}) {
  const getStoredTreeDataCustom = () => {
    return getStoredTreeData(repositoryFullName, branchName);
  };
  const saveTreeDataCustom = (treeData: Group[]) => {
    saveTreeData(repositoryFullName, branchName, treeData);
  };
  const [treeData, setTreeData] = useState(getStoredTreeDataCustom());
  const [orderBy, setOrderBy] = useState<"display" | "filter">("display");
  const treeDataOrdered = treeData.sort((a, b) => {
    if (orderBy === "display") {
      return a.displayPriority - b.displayPriority;
    }
    return a.filterPriority - b.filterPriority;
  });

  const sensors = useSensors(useSensor(PointerSensor));

  function addSection() {
    setTreeData([
      {
        regex: new RegExp(""),
        name: getNonDupNewName(treeData),
        filterPriority: 0,
        displayPriority: 0,
        persistent: false,
      },
      ...treeData.map((node) => {
        return {
          ...node,
          filterPriority: node.filterPriority + 1,
          displayPriority: node.displayPriority + 1,
        };
      }),
    ]);
  }

  function removeSection(name: string) {
    const removedNode = treeData.find((node) => node.name === name);
    const filterPriority = removedNode!.filterPriority;
    const displayPriority = removedNode!.displayPriority;
    const newTreeData = treeData
      .filter((node) => node.name !== name)
      .map((node) => {
        return {
          ...node,
          filterPriority:
            node.filterPriority > filterPriority
              ? node.filterPriority - 1
              : node.filterPriority,
          displayPriority:
            node.displayPriority > displayPriority
              ? node.displayPriority - 1
              : node.displayPriority,
        };
      });
    setTreeData(newTreeData);
  }

  function setItem(name: string, newName: string, regex: string) {
    setTreeData(
      treeData.map((node) => {
        if (node.name === name) {
          return {
            ...node,
            regex: new RegExp(regex),
            name: newName,
          };
        }
        return node;
      })
    );
  }

  const Node = React.memo(function Node({ data }: { data: Group }) {
    const { attributes, listeners, setNodeRef, transform, transition } =
      useSortable({ id: data.name });

    const style = {
      transform: CSS.Transform.toString(transform),
      transition,
    };

    return (
      <ListItem ref={setNodeRef} style={style} id={data.name}>
        <ListItemButton>
          <Stack
            direction="row"
            alignItems="center"
            justifyContent="space-between"
            flexGrow={1}
          >
            <Stack direction="row" alignItems={"center"} spacing={2}>
              <DragHandle {...attributes} {...listeners} />
              <Typography style={{ fontWeight: "bold" }}>
                {data.name}
              </Typography>
              <Typography>{data.regex.source}</Typography>
            </Stack>
            <Stack direction="row" alignItems={"center"}>
              <EditSectionDialog
                treeData={treeData}
                name={data.name}
                setGroup={setItem}
              />
              <Button onClick={() => removeSection(data.name)}>Delete</Button>
            </Stack>
          </Stack>
        </ListItemButton>
      </ListItem>
    );
  });

  function handleDragEnd(event: any) {
    const { active, over } = event;
    if (active == null || over == null) {
      return;
    }
    const priority =
      orderBy === "display" ? "displayPriority" : "filterPriority";
    const oldIndex = treeData.find((node) => node.name === active.id)![
      priority
    ];
    const newIndex = treeData.find((node) => node.name === over.id)![priority];
    if (oldIndex < newIndex) {
      setTreeData(
        treeData.map((node) => {
          if (node[priority] === oldIndex) {
            return {
              ...node,
              [priority]: newIndex,
            };
          } else if (oldIndex <= node[priority] && node[priority] <= newIndex) {
            return {
              ...node,
              [priority]: node[priority] - 1,
            };
          }
          return node;
        })
      );
    }
    if (newIndex < oldIndex) {
      setTreeData(
        treeData.map((node) => {
          if (node[priority] === oldIndex) {
            return {
              ...node,
              [priority]: newIndex,
            };
          } else if (newIndex <= node[priority] && node[priority] <= oldIndex) {
            return {
              ...node,
              [priority]: node[priority] + 1,
            };
          }
          return node;
        })
      );
    }
  }
  return (
    <Dialog
      open={visible}
      fullWidth={true}
      maxWidth="xl"
      onClose={() => {
        saveTreeDataCustom(treeData);
        handleClose();
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <Stack
        spacing={2}
        direction="row"
        justifyContent="space-between"
        flexGrow={1}
      >
        <Stack spacing={2} direction="row">
          <Button onClick={addSection}>Add</Button>
          <Button
            onClick={() => {
              saveTreeDataCustom(treeData);
              handleClose();
            }}
          >
            Save
          </Button>
          <ResetButton
            onConfirm={() => {
              saveTreeDataCustom(getDefaultGroupSettings());
              setTreeData(getDefaultGroupSettings());
            }}
          />
          <Button
            onClick={() =>
              setOrderBy(orderBy == "display" ? "filter" : "display")
            }
          >
            Ordering by {orderBy} precedence
          </Button>
          <ImportExportDialog treeData={treeData} setTreeData={setTreeData} />
        </Stack>
        <Button onClick={handleClose} color={"error"}>
          Close Without Saving
        </Button>
      </Stack>

      <List>
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={treeDataOrdered.map((node) => node.name)}
            strategy={verticalListSortingStrategy}
          >
            {treeDataOrdered.map((id) => (
              <Node key={id.name} data={id} />
            ))}
          </SortableContext>
        </DndContext>
      </List>
    </Dialog>
  );
}
