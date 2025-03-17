 import multiprocessing

def run_in_subprocess():
    try:
        import torch
        pass
    except Exception:
        traceback.print_exc()
        
if __name__ == "__main__":
    p = multiprocessing.Process(target=run_in_subprocess)
    p.start()
    p.join()
