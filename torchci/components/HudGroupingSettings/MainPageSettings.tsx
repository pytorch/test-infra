import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { KeyboardArrowDown } from "@mui/icons-material";
import KeyboardArrowUpIcon from "@mui/icons-material/KeyboardArrowUp";
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
  saveTreeData,
} from "./mainPageSettingsUtils";
import { set } from "lodash";

function validRegex(value: string) {
  try {
    new RegExp(value);
    return true;
  } catch (e) {
    return false;
  }
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
      <Button onClick={() => setOpen(true)}>Edit</Button>
      <Dialog
        open={open}
        closeAfterTransition={false}
        onClose={() => setOpen(false)}
        aria-modal
      >
        <DialogContent>
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
            onSubmit={(e) => {
              e.preventDefault();
              // @ts-ignore
              const regex = e.target[2].value;
              // @ts-ignore
              const newName = e.target[0].value;
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
          </Stack>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default function SettingsModal({
  visible,
  handleClose,
}: {
  visible: boolean;
  handleClose: () => void;
}) {
  const [treeData, setTreeData] = useState(getStoredTreeData());
  const [orderBy, setOrderBy] = useState<"display" | "filter">("display");
  const treeDataOrdered = treeData.sort((a, b) => {
    if (orderBy === "display") {
      return a.displayPriority - b.displayPriority;
    }
    return a.filterPriority - b.filterPriority;
  });

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

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
    setTreeData(treeData.filter((node) => node.name !== name));
  }

  function moveItem(name: string, direction: "up" | "down") {
    const group = treeData.find((node) => node.name === name)!;
    const index =
      orderBy === "display" ? group.displayPriority : group.filterPriority;
    const swapWithIndex = index + (direction === "down" ? 1 : -1);

    if (swapWithIndex < 0 || swapWithIndex >= treeData.length) {
      return;
    }
    const swapWith = treeData.find(
      (node) =>
        (orderBy === "display" ? node.displayPriority : node.filterPriority) ===
        swapWithIndex
    );

    if (orderBy == "display") {
      group.displayPriority = swapWithIndex;
      swapWith!.displayPriority = index;
    } else {
      group.filterPriority = swapWithIndex;
      swapWith!.filterPriority = index;
    }
    setTreeData([...treeData]);
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
      <ListItem ref={setNodeRef} style={style}  {...attributes} {...listeners} id={data.name}>
        <ListItemButton>
          <Stack
            direction="row"
            alignItems="center"
            justifyContent="space-between"
            flexGrow={1}
          >
            <Stack>
              <Typography style={{ fontWeight: "bold" }}>
                {data.name}
              </Typography>
              <Typography>{data.regex.source}</Typography>
            </Stack>
            <Stack direction="row" alignItems={"center"}>
              <Button onClick={() => moveItem(data.name, "up")}>
                <KeyboardArrowUpIcon />
              </Button>
              <Button onClick={() => moveItem(data.name, "down")}>
                <KeyboardArrowDown />
              </Button>
              <EditSectionDialog
                treeData={treeData}
                name={data.name}
                setGroup={setItem}
              />
              <Button onClick={(e) => removeSection(data.name)}>Delete</Button>
            </Stack>
          </Stack>
        </ListItemButton>
      </ListItem>
    );
  });
  function handleDragEnd(event: any) {
    const { active, over } = event;
    const priority = orderBy === "display" ? "displayPriority" : "filterPriority";
    console.log(active.id, over.id);
    treeDataOrdered.forEach((node) => {
      console.log(node.name, node[priority]);
    })

    const oldIndex = treeData.find((node) => node.name === active.id)![priority];
    const newIndex = treeData.find((node) => node.name === over.id)![priority];
    console.log(newIndex, oldIndex);
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
              [orderBy]: node[priority] - 1,
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
    // if (active.id !== over.id) {
    //   setItems((items) => {
    //     const oldIndex = items.indexOf(active.id);
    //     const newIndex = items.indexOf(over.id);

    //   });
    // }
  }
  return (
    <Dialog
      open={visible}
      fullWidth={true}
      maxWidth="xl"
      onClose={handleClose}
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
              saveTreeData(treeData);
              handleClose();
            }}
          >
            Save
          </Button>
          <Button
            onClick={() => {
              saveTreeData(getDefaultGroupSettings());
              setTreeData(getDefaultGroupSettings());
            }}
          >
            Reset
          </Button>
          <Button
            onClick={() =>
              setOrderBy(orderBy == "display" ? "filter" : "display")
            }
          >
            Ordering by {orderBy} precedence
          </Button>
        </Stack>
        <Button onClick={handleClose} color={"error"}>
          Close
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
              <Node key={id.name} data={id}/>
            ))}
          </SortableContext>
        </DndContext>
      </List>
    </Dialog>
  );
}
