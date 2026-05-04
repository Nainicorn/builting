FROM amazonlinux:2023

RUN yum -y update && \
    yum -y install tar gzip bzip2 ca-certificates && \
    yum clean all

ARG TARGETARCH
RUN ARCH=$([ "$TARGETARCH" = "arm64" ] && echo "aarch64" || echo "64") && \
    curl -Ls "https://micro.mamba.pm/api/micromamba/linux-${ARCH}/latest" | \
    tar -xvj -C /usr/local/bin --strip-components=1 bin/micromamba

ENV MAMBA_ROOT_PREFIX=/opt/conda
RUN micromamba create -y -n ifc -c conda-forge python=3.11 ifcopenshell && \
    micromamba clean -a -y

ENV PATH="/opt/conda/envs/ifc/bin:${PATH}"
ENV PYTHONPATH="/var/task:/opt/conda/envs/ifc/lib/python3.11/site-packages"

RUN /opt/conda/envs/ifc/bin/python -m pip install --no-cache-dir awslambdaric

COPY requirements.txt /var/task/requirements.txt
RUN /opt/conda/envs/ifc/bin/python -m pip install --no-cache-dir -r /var/task/requirements.txt

# Phase 13: Producer self-check — bake Pydantic contracts into image.
# Build context must include backend/shared/contracts/pydantic (via --build-context).
COPY --from=pydantic_contracts . /tmp/builting_contracts_pydantic
RUN /opt/conda/envs/ifc/bin/python -m pip install --no-cache-dir /tmp/builting_contracts_pydantic && \
    rm -rf /tmp/builting_contracts_pydantic

ARG BUILD_VERSION=13
ENV LAMBDA_BUILD_VERSION=$BUILD_VERSION
COPY lambda_function.py /var/task/lambda_function.py
COPY clean_tunnel_export.py /var/task/clean_tunnel_export.py
COPY clean_building_export.py /var/task/clean_building_export.py
COPY structural_walls.py /var/task/structural_walls.py
COPY visual_quality_gate.py /var/task/visual_quality_gate.py
COPY ifc_enrichment.py /var/task/ifc_enrichment.py
COPY spec_instance_emitter.py /var/task/spec_instance_emitter.py
COPY pipeline_trace.py /var/task/pipeline_trace.py
COPY audit.py /var/task/audit.py
COPY secondary_geometry/ /var/task/secondary_geometry/

ENTRYPOINT ["/opt/conda/envs/ifc/bin/python", "-m", "awslambdaric"]
CMD ["lambda_function.handler"]
