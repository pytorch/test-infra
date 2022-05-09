use crate::persistent_data::PersistentDataStore;
use anyhow::Result;
use console::style;
use dialoguer::{theme::ColorfulTheme, Select};

pub fn do_rage(
    persistent_data_store: &PersistentDataStore,
    invocation: Option<usize>,
) -> Result<i32> {
    let run = match invocation {
        Some(invocation) => Some(persistent_data_store.run(invocation)?),
        None => {
            let runs = persistent_data_store.runs()?;
            let items: Vec<String> = persistent_data_store
                .runs()?
                .iter()
                .map(|run| run.timestamp.to_string() + ": " + &run.args.join(" "))
                .collect();

            let selection = Select::with_theme(&ColorfulTheme::default())
                .with_prompt("Select a past invocation to report")
                .items(&items)
                .default(0)
                .interact_opt()?;

            selection.map(|i| runs.into_iter().nth(i).unwrap())
        }
    };

    match run {
        Some(run) => {
            let report = persistent_data_store.get_run_report(&run)?;
            print!("{}", report);
            Ok(0)
        }
        None => {
            println!("{}", style("Nothing selected, exiting.").yellow());
            Ok(1)
        }
    }
}
