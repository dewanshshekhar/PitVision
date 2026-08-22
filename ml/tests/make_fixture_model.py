"""Build a real ONNX model with the YOLOP output contract.

The pretrained weights cannot be downloaded in every environment — a locked-down
network blocks the model hosts — and waiting for them to test the plumbing means
the plumbing is only ever tested in production. This builds a genuine ONNX graph
with the same input signature and the same three outputs in the same layout, so
`RoadSegmenter` can be exercised end to end: session creation, letterboxing,
adapter dispatch, head identification, resolution mismatch, and mapping the mask
back onto the original frame.

What it does *not* test is whether a network can find a road. That needs the real
weights and real footage, and no fixture can stand in for it.

The graph is deliberately not random: it segments on green content, so a frame
with grey tarmac and green verges produces a road-shaped mask and the coordinate
round-trip can be checked against known geometry.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper


def build(path: Path, height: int = 384, width: int = 640) -> None:
    """Write a fixture graph.

    The heads are not random weights. They implement, in a handful of ops, the
    thing a trained road segmenter learns: asphalt is *near-colourless and
    mid-bright*, while sky is colourful and bright and vegetation is colourful
    and dark. A single 1x1 convolution cannot express that — it is a linear
    discriminant, and the three classes are not linearly separable in RGB — so
    the graph computes chroma and luma explicitly, which is also a fair
    stand-in for what the real network's last layer is doing.

        road = sigmoid( 30 * (0.12 - chroma) - 18 * |luma - 0.46| )
        lane = sigmoid( 30 * (0.12 - chroma) + 20 * (luma - 0.85) )

    That gives a road-shaped mask on a synthetic track scene, so the coordinate
    round-trip and the head-identification logic can be checked against known
    geometry.
    """
    inp = helper.make_tensor_value_info("images", TensorProto.FLOAT, [1, 3, height, width])

    def const(name: str, value: float):
        return numpy_helper.from_array(np.array([value], dtype=np.float32), name)

    nodes = [
        # Per-pixel colour statistics over the channel axis.
        helper.make_node("ReduceMax", ["images", "chan"], ["cmax"], keepdims=1, name="cmax"),
        helper.make_node("ReduceMin", ["images", "chan"], ["cmin"], keepdims=1, name="cmin"),
        helper.make_node("ReduceMean", ["images", "chan"], ["luma"], keepdims=1, name="luma"),
        helper.make_node("Sub", ["cmax", "cmin"], ["chroma"], name="chroma"),

        # Road: colourless, and near the brightness of asphalt.
        helper.make_node("Sub", ["k_chroma", "chroma"], ["grey"], name="grey"),
        helper.make_node("Mul", ["grey", "w_grey"], ["grey_term"], name="grey_term"),
        helper.make_node("Sub", ["luma", "k_road_luma"], ["dl"], name="dl"),
        helper.make_node("Abs", ["dl"], ["adl"], name="adl"),
        helper.make_node("Mul", ["adl", "w_luma"], ["luma_pen"], name="luma_pen"),
        helper.make_node("Sub", ["grey_term", "luma_pen"], ["road_logit"], name="road_logit"),

        # Lane: colourless and bright.
        helper.make_node("Sub", ["luma", "k_lane_luma"], ["dl2"], name="dl2"),
        helper.make_node("Mul", ["dl2", "w_lane_luma"], ["lane_bright"], name="lane_bright"),
        helper.make_node("Add", ["grey_term", "lane_bright"], ["lane_logit"], name="lane_logit"),

        # A stand-in detection head, so the adapter has to ignore something the
        # way it will with the real model.
        helper.make_node("ReduceMean", ["images", "det_axes"], ["det"], keepdims=1, name="det"),
    ]

    initialisers = [
        numpy_helper.from_array(np.array([1], dtype=np.int64), "chan"),
        numpy_helper.from_array(np.array([2, 3], dtype=np.int64), "det_axes"),
        const("k_chroma", 0.12),      # above this chroma, not asphalt
        const("w_grey", 30.0),
        const("k_road_luma", 0.46),   # asphalt sits near here
        const("w_luma", 18.0),
        const("k_lane_luma", 0.85),   # paint is much brighter
        const("w_lane_luma", 20.0),
    ]

    graph = helper.make_graph(
        nodes,
        "pitvision_fixture_yolop",
        [inp],
        [
            # Detection first, matching the real export order — the adapter must
            # not depend on position.
            helper.make_tensor_value_info("det", TensorProto.FLOAT, [1, 3, 1, 1]),
            helper.make_tensor_value_info("road_logit", TensorProto.FLOAT, [1, 1, height, width]),
            helper.make_tensor_value_info("lane_logit", TensorProto.FLOAT, [1, 1, height, width]),
        ],
        initialisers,
    )

    model = helper.make_model(
        graph,
        producer_name="pitvision-test-fixture",
        opset_imports=[helper.make_operatorsetid("", 18)],
    )
    model.ir_version = 10
    onnx.checker.check_model(model)
    path.parent.mkdir(parents=True, exist_ok=True)
    onnx.save(model, str(path))


if __name__ == "__main__":
    out = Path(sys.argv[1] if len(sys.argv) > 1 else "ml/models/_fixture.onnx")
    build(out)
    print(f"wrote {out} ({out.stat().st_size} bytes)")
