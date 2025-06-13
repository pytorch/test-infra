import React from "react";
import { Typography, Box, useTheme } from "@mui/material";
import CheckBoxIcon from "@mui/icons-material/CheckBox";
import CheckBoxOutlineBlankIcon from "@mui/icons-material/CheckBoxOutlineBlank";
import { TodoItem as TodoItemType } from "./types";
import { TodoListBlock, TodoListTitle, TodoItem } from "./styles";

interface TodoListProps {
  todoItems: TodoItemType[];
  timestamp?: number;
}

export const TodoList: React.FC<TodoListProps> = ({ todoItems, timestamp }) => {
  const theme = useTheme();

  return (
    <TodoListBlock>
      <TodoListTitle variant="subtitle1">
        <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          <CheckBoxIcon
            sx={{
              color: theme.palette.mode === "dark" ? "#9c27b0" : "#673ab7",
            }}
          />
          Todo List
        </Box>
      </TodoListTitle>

      <Box sx={{ pl: 1 }}>
        {todoItems.map((todo) => (
          <TodoItem key={todo.id} status={todo.status}>
            <Box
              sx={{
                display: "flex",
                alignItems: "flex-start",
                gap: 1.5,
              }}
            >
              {todo.status === "completed" ? (
                <CheckBoxIcon color="success" sx={{ mt: 0.3 }} />
              ) : (
                <CheckBoxOutlineBlankIcon
                  sx={{
                    mt: 0.3,
                    color:
                      todo.status === "in_progress"
                        ? theme.palette.mode === "dark"
                          ? "#f0c674"
                          : "#ed6c02"
                        : "text.secondary",
                  }}
                />
              )}
              <Typography
                variant="body2"
                component="span"
                sx={{
                  wordBreak: "break-word",
                  fontFamily: "Roboto, 'Helvetica Neue', Arial, sans-serif",
                }}
              >
                {todo.content}
              </Typography>
            </Box>
          </TodoItem>
        ))}
      </Box>

      <Typography
        variant="caption"
        sx={{
          display: "block",
          mt: 2,
          textAlign: "right",
          color: "text.secondary",
          fontStyle: "italic",
        }}
      >
        Last updated:{" "}
        {timestamp ? new Date(timestamp).toLocaleTimeString() : "Unknown"}
      </Typography>
    </TodoListBlock>
  );
};