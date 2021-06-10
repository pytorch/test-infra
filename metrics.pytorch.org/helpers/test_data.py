import psycopg2
from pgcopy import CopyManager

import sys

CONNECTION = f"postgres://postgres:{sys.argv[1]}@metrics.pytorch.org:5432/pytorch"



def create_table():  
    conn = psycopg2.connect(CONNECTION)
    cursor = conn.cursor()
    # use the cursor to interact with your database
    cursor.execute("SELECT 'hello world'")
    print(cursor.fetchone())

    actions_job_status = """CREATE TABLE actions_job_status (
                                           time TIMESTAMPTZ NOT NULL,
                                           queued INTEGER,
                                           in_progress INTEGER,
                                           pending INTEGER
                                           );"""
    cursor.execute(actions_job_status)
    conn.commit()
    cursor.close()


def add_fake_data():  
    conn = psycopg2.connect(CONNECTION)
    cursor = conn.cursor()
    simulate_query = """SELECT generate_series(now() - interval '24 hour', now(), interval '5 minute') AS time,
                            floor(random()*100)::int AS queued,
                            floor(random()*100)::int AS in_progress,
                            floor(random()*100)::int AS pending
                            """
    cursor.execute(simulate_query)
    values = cursor.fetchall()

    cols = ['time', 'queued', 'in_progress', 'pending']
    mgr = CopyManager(conn, 'actions_job_status', cols)
    mgr.copy(values)
    conn.commit()




create_table()
add_fake_data()