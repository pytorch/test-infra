#! /bin/bash

function main {
    local reverse=false format='%ct'
    DEBUG=false
    local helpstring="List files in a git repo along with when they were last updated.\n\t-d\tdebug mode (truncate input)\n\t-r\treverse sort order (default oldest first)\n\t-f\tset git date format string (e.g. %cr, %cd, etc.)\n\t-h\tdisplay this help.\n"

    OPTIND=1
    while getopts "drf:h" opt; do
        case $opt in
            d) DEBUG=true ;;
            r) reverse=true ;;
            f) format=$OPTARG ;;
            h) echo -e $helpstring; return;;
            *) return 1;;
        esac
    done
    shift $((OPTIND-1))

    readonly DEBUG

    # If debug is only process 50 filenames
    if $DEBUG; then
        FILTER='head -n 50'
    else
        FILTER='tee'
    fi

    ack_file_info $format | clean_input | sort_cleaned_input $reverse | clean_output
}

# Use ack's -f flag to just list files. We could use pretty much anything here,
# but I'm tempted to allow passing args to ack later
function ack_file_info {
    local format="$1"

    ack -f |\
    $FILTER |\
    xargs -I § git log -1 --pretty="format:%ct	${format}	%h	§;" §
}

# I'm not sure what goes one above, but on Mac OSX, the output of xargs loses
# its newlines when it's piped through a filter. So replace ; with \n as a
# bodge to fix this.
function clean_input {
    tr ';' '\n'
}

function sort_cleaned_input {
    local reverse="$1"

    if $reverse; then
        sort -r
    else
        sort
    fi
}

# Trim commit timestamps from output
function clean_output {
    cut -f 2-
}

main "$@"
