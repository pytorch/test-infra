def fix_tables(session, engine, objects, orm_objects):
    # For each of the objects, ensure the schema in the DB contains that in the
    # orm_objects.
    from sqlalchemy import inspect

    inspector = inspect(engine)

    def column_type_sql(column) -> str:
        return column.type.compile(engine.dialect)

    from sqlalchemy.sql import text

    tables = inspector.get_table_names()
    for orm in orm_objects:
        if orm.__tablename__ not in tables:
            # The ORM will insert the table for us if it's not there
            continue

        sql_columns = inspector.get_columns(orm.__tablename__)
        sql_columns_map = {item["name"]: item for item in sql_columns}
        orm_columns = {k: v for k, v in orm.__dict__.items() if not k.startswith("_")}
        # print(sql_columns_map.keys())
        for new_key in orm_columns:
            if new_key not in sql_columns_map:
                maybe_type = TYPE_MAP.get(orm.__tablename__, {}).get(new_key, None)
                if maybe_type is not None:
                    continue
                # session.execute()
                data = {
                    "tablename": orm.__tablename__,
                    "colname": new_key,
                }
                breakpoint()
                tablename = sqlalchemy.String("").literal_processor(
                    dialect=engine.dialect
                )(value=orm.__tablename__)
                colname = sqlalchemy.String("").literal_processor(
                    dialect=engine.dialect
                )(value=new_key)
                # print(a)
                tablename = tablename.strip("'")
                colname = colname.strip("'")
                # sql_command = text(f"ALTER TABLE `:tablename` ADD COLUMN `:colname` {column_type_sql(orm.__class__.__dict__[new_key])};")
                sql_command = f"alter table `{tablename}` add column `{colname}` {column_type_sql(orm.__class__.__dict__[new_key])}"
                print(f"MISMATCH {orm.__tablename__}.{new_key} DOESNT EXIST")
                print(sql_command)
                with engine.connect() as con:
                    print(sql_command)
                    con.execute(sql_command)
                # session.execute(sql_command)
        # print(orm_columns.keys())
        # break

    for table_name in inspector.get_table_names():
        for column in inspector.get_columns(table_name):

            # print("Column: %s" % column['name'])
            pass

    # exit(0)




        # try:
    #     session.commit()
    # except Exception as e:
    #     fix_tables(session, engine, objects, orm_objects)
    #     session.commit()
    #     print("FAILED", e.args[0])
    #     pass
    #     # raise e
    # # print("wrote")