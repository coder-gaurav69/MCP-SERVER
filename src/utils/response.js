export function success(action, data = {}) {
  return {
    status: "success",
    action,
    data,
    error: ""
  };
}

export function failure(action, error, data = {}) {
  return {
    status: "error",
    action,
    data,
    error: error instanceof Error ? error.message : String(error || "Unknown error")
  };
}
