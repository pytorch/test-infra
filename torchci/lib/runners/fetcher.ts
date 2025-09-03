// Shared fetcher for runners API with authentication

export const runnersFetcher = async (url: string) => {
  // TODO: Remove this bypass before production - AUTH DISABLED FOR TESTING
  // const { data: session } = await fetch("/api/auth/session").then(res => res.json());
  //
  // if (!session?.accessToken) {
  //   throw new Error("Not authenticated");
  // }

  const response = await fetch(url, {
    // headers: {
    //   Authorization: session.accessToken,
    // },
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || "Failed to fetch runners");
  }

  return response.json();
};