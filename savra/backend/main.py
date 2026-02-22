import os
import openpyxl
import pandas as pd
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from typing import Dict, List

app = FastAPI(title="Savra Teacher Insights API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
EXCEL_PATH = os.path.join(BASE_DIR, "..", "Savra_Teacher Data Set-1 copy.xlsx")


def load_data() -> pd.DataFrame:
    wb = openpyxl.load_workbook(EXCEL_PATH)
    ws = wb.active
    rows = list(ws.iter_rows(values_only=True))
    headers = rows[0]
    data = [dict(zip(headers, row)) for row in rows[1:]]
    df = pd.DataFrame(data)
    df = df.drop_duplicates()
    df["date"] = pd.to_datetime(df["Created_at"], format="%Y-%m-%d %H:%M:%S", errors="coerce").dt.date
    df["month"] = pd.to_datetime(df["Created_at"], format="%Y-%m-%d %H:%M:%S", errors="coerce").dt.strftime("%Y-%m")
    df["is_assessment"] = df["Activity_type"].isin(["Quiz", "Question Paper"])
    df["is_lesson"] = df["Activity_type"] == "Lesson Plan"
    df["is_quiz"] = df["Activity_type"] == "Quiz"
    df["is_question_paper"] = df["Activity_type"] == "Question Paper"
    return df


_cache: dict = {"df": None, "mtime": None}


def get_df() -> pd.DataFrame:
    mtime = os.path.getmtime(EXCEL_PATH)
    if _cache["df"] is None or _cache["mtime"] != mtime:
        _cache["df"] = load_data()
        _cache["mtime"] = mtime
    return _cache["df"]


def compute_leaderboard(df: pd.DataFrame) -> List[Dict]:
    teachers = df.groupby(["Teacher_id", "Teacher_name"]).agg(
        assessments=("is_assessment", "sum"),
        lessons=("is_lesson", "sum"),
    ).reset_index()

    teachers["raw_score"] = teachers["assessments"] * 0.6 + teachers["lessons"] * 0.4

    min_s = teachers["raw_score"].min()
    max_s = teachers["raw_score"].max()
    if max_s == min_s:
        teachers["score"] = 5.0
    else:
        teachers["score"] = ((teachers["raw_score"] - min_s) / (max_s - min_s)) * 10

    teachers["score"] = teachers["score"].round(2)

    grades_map = (
        df.groupby("Teacher_name")["Grade"]
        .apply(lambda x: sorted(x.unique().tolist()))
        .to_dict()
    )

    result = []
    for _, row in teachers.iterrows():
        result.append({
            "teacher_id": row["Teacher_id"],
            "teacher_name": row["Teacher_name"],
            "assessments": int(row["assessments"]),
            "lessons": int(row["lessons"]),
            "score": float(row["score"]),
            "grades_taught": grades_map.get(row["Teacher_name"], []),
        })

    return sorted(result, key=lambda x: x["score"], reverse=True)


@app.get("/api/leaderboard")
def get_leaderboard():
    lb = compute_leaderboard(get_df())
    return {"leaderboard": lb}


@app.get("/api/teachers")
def get_teachers():
    lb = compute_leaderboard(get_df())
    return {"teachers": [{"teacher_id": t["teacher_id"], "teacher_name": t["teacher_name"]} for t in lb]}


@app.get("/api/teacher/{teacher_name}")
def get_teacher(teacher_name: str):
    df = get_df()
    df = df[df["Teacher_name"] == teacher_name]
    if df.empty:
        return {"error": "Teacher not found"}

    lb = compute_leaderboard(get_df())
    score_map = {t["teacher_name"]: t["score"] for t in lb}

    assess_df = df[df["is_assessment"]]
    grade_subject = (
        assess_df.groupby(["Grade", "Subject"])
        .size()
        .reset_index(name="count")
    )
    grades = sorted(assess_df["Grade"].unique().tolist())
    subjects = sorted(assess_df["Subject"].unique().tolist())

    grade_subject_data = {}
    for _, row in grade_subject.iterrows():
        g = str(row["Grade"])
        s = row["Subject"]
        grade_subject_data.setdefault(g, {})[s] = int(row["count"])

    timeline_raw = []
    for _, row in assess_df.iterrows():
        if row["date"]:
            timeline_raw.append({
                "date": str(row["date"]),
                "month": row["month"],
                "subject": row["Subject"],
            })

    timeline_by_month: Dict[str, Dict[str, int]] = {}
    for item in timeline_raw:
        m = item["month"]
        d = item["date"]
        timeline_by_month.setdefault(m, {})
        timeline_by_month[m][d] = timeline_by_month[m].get(d, 0) + 1

    if not assess_df.empty:
        most_taught = assess_df["Subject"].value_counts().idxmax()
    else:
        most_taught = "N/A"

    total_lessons = int(df["is_lesson"].sum())
    total_quizzes = int(df["is_quiz"].sum())
    total_question_papers = int(df["is_question_paper"].sum())
    total_assessments = total_quizzes + total_question_papers

    all_subjects = sorted(df["Subject"].dropna().unique().tolist())

    return {
        "teacher_name": teacher_name,
        "score": score_map.get(teacher_name, 0),
        "grades": [str(g) for g in grades],
        "subjects": subjects,
        "all_subjects": all_subjects,
        "grade_subject_data": grade_subject_data,
        "timeline_by_month": timeline_by_month,
        "months": sorted(timeline_by_month.keys()),
        "most_taught_subject": most_taught,
        "total_lessons": total_lessons,
        "total_quizzes": total_quizzes,
        "total_question_papers": total_question_papers,
        "total_assessments": total_assessments,
    }


@app.get("/api/grades")
def get_grades():
    df = get_df()
    grades = sorted(df["Grade"].unique().tolist())
    return {"grades": [str(g) for g in grades]}


@app.get("/api/grade/{grade}")
def get_grade(grade: int):
    df = get_df()
    df = df[df["Grade"] == grade]
    if df.empty:
        return {"error": "Grade not found"}

    assess_df = df[df["is_assessment"]]
    total = len(assess_df)

    teacher_counts = (
        assess_df.groupby("Teacher_name")
        .size()
        .reset_index(name="count")
    )
    teacher_data = [
        {"teacher": row["Teacher_name"], "count": int(row["count"])}
        for _, row in teacher_counts.iterrows()
        if row["count"] > 0
    ]

    all_teachers = sorted(df["Teacher_name"].unique().tolist())

    return {
        "grade": grade,
        "total_assessments": total,
        "teacher_data": teacher_data,
        "teachers": all_teachers,
    }


@app.get("/api/overall")
def get_overall():
    df = get_df()
    lb = compute_leaderboard(df)
    total_assessments = int(df["is_assessment"].sum())
    total_lessons = int(df["is_lesson"].sum())
    total_quizzes = int(df["is_quiz"].sum())
    total_question_papers = int(df["is_question_paper"].sum())
    grades = sorted(df["Grade"].unique().tolist())
    subjects = sorted(df["Subject"].unique().tolist())

    activity_counts = df["Activity_type"].value_counts().to_dict()

    assess_df = df[df["is_assessment"]]
    assessments_by_grade = (
        assess_df.groupby("Grade").size().reset_index(name="count")
    )
    grade_chart = {
        "labels": [f"Grade {int(r['Grade'])}" for _, r in assessments_by_grade.iterrows()],
        "data": [int(r["count"]) for _, r in assessments_by_grade.iterrows()],
    }

    activity_chart = {
        "labels": list(activity_counts.keys()),
        "data": [int(v) for v in activity_counts.values()],
    }

    monthly = df.groupby("month").size().reset_index(name="count")
    monthly = monthly.sort_values("month")
    monthly_chart = {
        "labels": monthly["month"].tolist(),
        "data": monthly["count"].tolist(),
    }

    top_teacher = lb[0] if lb else None

    return {
        "total_teachers": len(lb),
        "total_assessments": total_assessments,
        "total_lessons": total_lessons,
        "total_quizzes": total_quizzes,
        "total_question_papers": total_question_papers,
        "total_activities": int(len(df)),
        "grades": [str(g) for g in grades],
        "subjects": subjects,
        "leaderboard": lb,
        "grade_chart": grade_chart,
        "activity_chart": activity_chart,
        "monthly_chart": monthly_chart,
        "top_teacher": top_teacher,
    }


@app.get("/")
def root():
    return {"message": "Savra Teacher Insights API is running"}
