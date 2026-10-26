"""Unique strings planted in the metadata fixtures. The e2e tests search OUTPUT FILE BYTES for them (raw search,
not the app's own parser), so a marker found in an output file is a real leak."""
M = dict(make='MARKER_MAKE_7f3a', model='MARKER_MODEL_9c1d', soft='MARKER_SOFT_1e44', artist='MARKER_ARTIST_b7a2',
         desc='MARKER_DESC_5b2e', gpsmeth='MARKER_GPSMETHOD_3f6c', serial='MARKER_SERIAL_8d20', xmp='MARKER_XMP_4d8e',
         comment='MARKER_COMMENT_2a9f', trail='MARKER_TRAIL_6e0b', ptext='MARKER_PNGTEXT_8c3d', pitxt='MARKER_PNGITXT_0f13',
         pztxt='MARKER_PNGZTXT_a6e7', pprivate='MARKER_PNGPRIVATE_51c9')
MARKERS = list(M.values())
