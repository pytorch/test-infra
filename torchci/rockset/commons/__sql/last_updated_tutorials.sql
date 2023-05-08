 SELECT
    files.filename,
    MAX(CAST(metadata.date as date)) as last_updated
FROM
    tutorials.metadata as metadata 
JOIN 
    tutorials.filenames as files
ON 
    files.commit_id = metadata.commit_id

WHERE
    REGEXP_LIKE(
        files.filename,
        'beginner_source|intermediate_source|advanced_source|prototype_source|recipes_source'
    )
    AND REGEXP_LIKE(files.filename, '.py|.rst|.ipnyb')
    AND files.filename NOT LIKE '%README%'
    AND files.filename NOT LIKE '%index%'
    AND files.filename NOT LIKE '%former_torchies%'
    AND files.filename NOT LIKE '%=>%'
    AND files.filename NOT LIKE '%colab.rst%'
    AND files.filename NOT LIKE 'prototype_source/graph_mode_static_quantization_tutorial.py'
    AND files.filename NOT LIKE 'beginner_source/profiler_tutorial_.py'
    AND files.filename NOT LIKE 'recipes_source/recipes/profiler.py'
    AND files.filename NOT LIKE '%test.py%'
    AND files.filename NOT LIKE '%main.py%'
    AND files.filename NOT LIKE '%export_attr.py%'
    AND files.filename NOT LIKE '%custom_class_project/save.py%'
    AND files.filename NOT LIKE '%Warmstarting_model_using_parameters_from_a_different_model_in_PyTorch%'
    AND files.filename NOT LIKE 'beginner_source/blitz/tensorboard_tutorial.py'
    AND files.filename NOT LIKE 'intermediate_source/flask_tutorial/app.py'
    AND files.filename NOT LIKE 'intermediate_source/flask_tutorial/test_flask.py'
    AND files.filename NOT LIKE 'beginner_source/blitz/tensorboard_tutorial.py' 
    AND files.filename NOT LIKE 'beginner_source/blitz/cifar10_tensorboard_tutorial.py'
    AND files.filename NOT LIKE 'beginner_source/text_sentiment_ngrams.py'
    AND files.filename NOT LIKE 'beginner_source/audio_classifier_tutorial.py'
    AND files.filename NOT LIKE 'beginner_source/nn_basics.py'
    AND files.filename NOT LIKE 'beginner_source/hybrid_frontend/introduction_to_hybrid_frontend_tutorial.py'
    AND files.filename NOT LIKE 'beginner_source/caffe2_onnx_primer_tutorial.py'
    AND files.filename NOT LIKE 'advanced_source/c_extension.rst'
    AND files.filename NOT LIKE 'beginner_source/deep_learning_nlp_tutorial.py'
    AND files.filename NOT LIKE 'beginner_source/deep_learning_nlp.py'
GROUP BY
    files.filename
ORDER BY
    last_updated DESC
LIMIT
    1000
