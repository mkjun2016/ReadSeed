"""스캔한 PDF 쪽 이미지에서 글줄과 위치를 읽는 OCR.

macOS 내장 Vision(문자 인식)을 쓴다. 기기 안에서 동작해 원문이 외부로 나가지 않고,
별도 비용이 없다. 다른 운영체제에서는 RuntimeError로 알린다.

반환하는 좌표는 쪽 크기에 대한 비율(0~1)이며 원점은 왼쪽 위다.
"""

MAX_IMAGE_BYTES = 20 * 1024 * 1024


def recognize(image: bytes) -> list[dict]:
    """이미지 바이트에서 글줄 목록 {text, x, y, w, h, confidence}를 읽는다."""
    if not image or len(image) > MAX_IMAGE_BYTES:
        raise ValueError("image must be between 1 byte and 20 MB")
    try:
        import Vision
        from Foundation import NSData
    except ImportError as exc:
        raise RuntimeError("OCR needs macOS Vision (pyobjc-framework-Vision)") from exc

    data = NSData.dataWithBytes_length_(image, len(image))
    handler = Vision.VNImageRequestHandler.alloc().initWithData_options_(data, None)
    request = Vision.VNRecognizeTextRequest.alloc().init()
    request.setRecognitionLanguages_(["ko-KR"])
    request.setRecognitionLevel_(Vision.VNRequestTextRecognitionLevelAccurate)
    request.setUsesLanguageCorrection_(True)
    ok, error = handler.performRequests_error_([request], None)
    if not ok:
        raise ValueError(f"image could not be read: {error}")

    lines = []
    for observation in request.results() or []:
        candidates = observation.topCandidates_(1)
        if not candidates:
            continue
        top = candidates[0]
        box = observation.boundingBox()  # Vision의 원점은 왼쪽 아래다.
        lines.append({
            "text": str(top.string()),
            "x": float(box.origin.x),
            "y": float(1 - box.origin.y - box.size.height),
            "w": float(box.size.width),
            "h": float(box.size.height),
            "confidence": float(top.confidence()),
        })
    return lines
