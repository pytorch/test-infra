from typing import List
import openai
import os
from tenacity import retry, stop_after_attempt, wait_random_exponential
import tiktoken
from openai.embeddings_utils import get_embedding, cosine_similarity, aget_embedding
import sys 
openai.api_key = os.getenv("OPENAI_API_KEY")
import asyncio
import argparse

CHUNK_SIZE = 4096
OVERLAP_SIZE = 2048
TOP_K = 1
CHUNKS_NUM_FOR_DEBUG = 5
# MAX_BATCH_SIZE = 2048
MAX_BATCH_SIZE = 126

# taken from openai.embeddings_utils with a more aggressive retry params
@retry(wait=wait_random_exponential(min=1, max=60), stop=stop_after_attempt(20))
async def aget_embeddings(
    list_of_text: List[str], engine="text-similarity-babbage-001", **kwargs
) -> List[List[float]]:
    assert len(list_of_text) <= 2048, "The batch size should not be larger than 2048."

    # replace newlines, which can negatively affect performance.
    list_of_text = [text.replace("\n", " ") for text in list_of_text]

    data = (await openai.Embedding.acreate(input=list_of_text, engine=engine, **kwargs)).data
    data = sorted(data, key=lambda x: x["index"])  # maintain the same order as input.
    return [d["embedding"] for d in data]

def _get_tokens_from_file(file_path):
    """Get the tokens from the file."""
    text = open(file_path, "r").read()
    enc = tiktoken.encoding_for_model("text-embedding-ada-002")
    assert enc.decode(enc.encode("hello world")) == "hello world"
    return enc.encode(text)

def _get_text_from_tokens(tokens):
    """Get the text from the tokens."""
    enc = tiktoken.encoding_for_model("text-embedding-ada-002")
    return enc.decode(tokens)

async def _get_embedding_chunks_from_file(file_path):
    """Get the embedding chunks from the file path."""
    tokens = _get_tokens_from_file(file_path)
    chunks = [tokens[0:CHUNK_SIZE]]
    text_chunks = []
    embeddings = []
    for i in range(CHUNK_SIZE - OVERLAP_SIZE, len(tokens), CHUNK_SIZE - OVERLAP_SIZE):
        chunks.append(tokens[i:min(i+CHUNK_SIZE, len (tokens))])
    text_chunks = [_get_text_from_tokens(chunk) for chunk in chunks]
    batched_chunks = [text_chunks[i:i+MAX_BATCH_SIZE] for i in range(0, len(chunks), MAX_BATCH_SIZE)]
    for batch in batched_chunks:
        # print(f"processing batch number ", batched_chunks.index(batch), "out of ", len(batched_chunks), file=sys.stderr)
        # print(len(batch), file=sys.stderr)
        embeddings += await aget_embeddings(batch, engine="text-embedding-ada-002")
    return zip(embeddings, text_chunks)
    

async def main(success_file, failure_file):
    # Get embedding chunks from the good and bad files
    embeddings_on_good_file = list(await _get_embedding_chunks_from_file("data/log7_success.txt"))
    embeddings_on_bad_file = list(await _get_embedding_chunks_from_file("data/log7_failures.txt"))

    # Create a list of pairs of (total cosine similarity, text chunk) for each text chunk in the bad file
    text_chunk_pairs = []
    for embedding_bad, text_chunk in embeddings_on_bad_file:
        cosine_similarities = [cosine_similarity(embedding_bad, embedding2) for embedding2, _ in embeddings_on_good_file]
        top_k = sorted(cosine_similarities)[-TOP_K:]
        total = sum(top_k)
        text_chunk_pairs.append((total, text_chunk))
                                
    # Sort the list of (total cosine similarity, text chunk) pairs by the cosine similarity
    text_chunk_pairs = sorted(text_chunk_pairs, key=lambda x: x[0])

    # Print the text chunks and their cosine similarities in order
    for text_chunk_pair in text_chunk_pairs:
        print("=======================================================")
        print("pair number: ", text_chunk_pairs.index(text_chunk_pair))
        print("Similarity: ", text_chunk_pair[0])
        print(text_chunk_pair[1])
        print()



    

if __name__ == "__main__":
    # get success file and failure file from io
    parser = argparse.ArgumentParser()
    parser.add_argument("--success_file", help="success file", default="data/log7_success.txt")
    parser.add_argument("--failure_file", help="failure file", default="data/log7_failures.txt")
    args = parser.parse_args()
    asyncio.run(main(args.success_file, args.failure_file))

# response = get_embedding("Hello, my name is John!")
# print(len(response))
# response = get_embedding("Hello, my name is John! more tokens")
# print(len(response))
