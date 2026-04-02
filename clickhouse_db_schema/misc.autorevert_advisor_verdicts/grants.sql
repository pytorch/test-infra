-- Grant SELECT to revert_lambda (used by the autorevert lambda to read advisor verdicts)
GRANT SELECT ON misc.autorevert_advisor_verdicts TO revert_lambda;
